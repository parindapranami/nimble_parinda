import asyncio
import json
import logging
from typing import Optional
import aiortc
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack, RTCConfiguration, RTCIceServer
from av import VideoFrame
import fractions
import numpy as np
import time

from aioquic.asyncio import QuicConnectionProtocol
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import HeadersReceived, WebTransportStreamDataReceived, H3Event
from aioquic.quic.events import QuicEvent, ProtocolNegotiated, StreamReset

from .ball_generator import BallGenerator
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

class WebTransportProtocol(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http: Optional[H3Connection] = None
        self._handler: Optional[WebRtcHandler] = None
    
    def quic_event_received(self, event: QuicEvent) -> None:
        if isinstance(event, ProtocolNegotiated):
            self._http = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(event, StreamReset) and self._handler is not None:
            self._handler.stream_closed(event.stream_id)
        
        if self._http is not None:
            for h3_event in self._http.handle_event(event):
                self._h3_event_received(h3_event)
    
    def _h3_event_received(self, event: H3Event) -> None:
        if not self._http:
            return
            
        if isinstance(event, HeadersReceived):
            headers = dict(event.headers)
            method = headers.get(b":method")
            protocol = headers.get(b":protocol")
            path = headers.get(b":path")

            if method == b"CONNECT" and protocol == b"webtransport" and path == b"/connection":
                logger.info("WebTransport connection accepted")
                self._handler = WebRtcHandler(event.stream_id, self._http)
                self._http.send_headers(
                    stream_id=event.stream_id,
                    headers=[
                        (b":status", b"200"),
                        (b"sec-webtransport-http3-draft", b"draft02"),
                    ]
                )
        elif isinstance(event, WebTransportStreamDataReceived):
            pass
        
        if self._handler:
            self._handler.h3_event_received(event)

class WebRtcHandler:
    def __init__(self, session_id: int, http_connection):
        self._session_id = session_id
        self._http = http_connection
        self._stream_buffers = {}
        self.peer_connection = None
        self.ball_generator = None
        self.video_task = None
        self._tasks = set()  # Track all created asyncio tasks
        self._video_stream_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()  # New lock for shared state
        self._offer_in_progress = False  # Track if an SDP offer is being processed
        
        # Configure ICE servers for the server
        self.ice_servers = [
            RTCIceServer("stun:stun.l.google.com:19302"),
            RTCIceServer("stun:stun1.l.google.com:19302"),
            RTCIceServer("stun:stun2.l.google.com:19302")
        ]
        self.rtc_config = RTCConfiguration(iceServers=self.ice_servers)
        
        logger.info(f"WebRtcHandler initialized for session: {session_id}")
    
    def h3_event_received(self, event):
        if hasattr(event, 'stream_id') and hasattr(event, 'data') and hasattr(event, 'stream_ended'):
            # Handle unidirectional stream data (SDP offer or coords)
            # Lock for _stream_buffers
            async def handle_stream():
                async with self._state_lock:
                    if event.stream_id not in self._stream_buffers:
                        self._stream_buffers[event.stream_id] = bytearray()
                    if event.data:
                        self._stream_buffers[event.stream_id].extend(event.data)
                    if event.stream_ended:
                        logger.info(f"Stream {event.stream_id} ended, processing message")
                        data = bytes(self._stream_buffers[event.stream_id])
                        try:
                            message = json.loads(data.decode())
                            message_type = message.get('type', 'unknown')
                            if message_type == 'offer':
                                logger.info("Processing SDP offer")
                                task = asyncio.create_task(self.handle_sdp_offer(data))
                                self._tasks.add(task)
                                task.add_done_callback(self._tasks.discard)
                            elif message_type == 'coords':
                                task = asyncio.create_task(self.handle_client_coords(message))
                                self._tasks.add(task)
                                task.add_done_callback(self._tasks.discard)
                            else:
                                logger.warning(f"Unknown message type: {message_type}")
                        except json.JSONDecodeError:
                            logger.error("Failed to parse message as JSON")
                        except Exception as e:
                            logger.error(f"Error processing message: {e}")
                        del self._stream_buffers[event.stream_id]
            asyncio.create_task(handle_stream())
        else:
            if self._handler:
                self._handler.h3_event_received(event)
    
    def stream_closed(self, stream_id: int):
        # No longer delete the buffer here; let the handler task in h3_event_received handle cleanup after processing
        pass
    
    async def handle_sdp_offer(self, raw_data: bytes):
        async with self._state_lock:
            if self._offer_in_progress:
                logger.warning("SDP offer received while another is in progress. Ignoring this offer.")
                return
            # Check if there's already an active peer connection
            if self.peer_connection and self.peer_connection.connectionState != "closed":
                logger.warning("SDP offer received while peer connection is still active. Closing existing connection.")
                try:
                    await self.peer_connection.close()
                except Exception as e:
                    logger.error(f"Error closing existing peer connection: {e}")
            self._offer_in_progress = True
        try:
            data = json.loads(raw_data.decode())
            logger.info(f"Processing SDP offer")
            if 'type' not in data or 'sdp' not in data:
                logger.error("Invalid SDP offer format")
                return
            # Create RTCPeerConnection with ICE configuration
            offer = RTCSessionDescription(sdp=data['sdp'], type=data['type'])
            # Configure RTCPeerConnection with ICE settings
            pc = RTCPeerConnection(configuration=self.rtc_config)
            self.peer_connection = pc
            # Set up event handlers
            @pc.on("connectionstatechange")
            async def on_connectionstatechange():
                try:
                    logger.info(f"Connection state: {pc.connectionState}")
                    if pc.connectionState == "connected":
                        logger.info("WebRTC connection established")
                        await self.start_video_stream()
                    elif pc.connectionState in ["failed", "closed"]:
                        logger.info("WebRTC connection closed")
                        await self.stop_video_stream()
                        try:
                            await pc.close()
                        except Exception as e:
                            logger.error(f"Error closing peer connection: {e}")
                except Exception as e:
                    logger.error(f"Error in connection state change handler: {e}")
            @pc.on("iceconnectionstatechange")
            async def on_iceconnectionstatechange():
                try:
                    if pc.iceConnectionState == "connected":
                        logger.info("ICE connection established")
                        await self.start_video_stream()
                    elif pc.iceConnectionState == "failed":
                        logger.error("ICE connection failed")
                        await self.stop_video_stream()
                    elif pc.iceConnectionState == "checking":
                        logger.info("ICE checking...")
                    elif pc.iceConnectionState == "closed":
                        logger.info("ICE connection closed")
                        await self.stop_video_stream()
                except Exception as e:
                    logger.error(f"Error in ICE connection state change handler: {e}")
            @pc.on("track")
            async def on_track(track: MediaStreamTrack):
                try:
                    if track.kind == "video":
                        logger.info("Video track received")
                except Exception as e:
                    logger.error(f"Error in track handler: {e}")
            # Set remote description (the offer)
            await pc.setRemoteDescription(offer)
            logger.info("Remote description set")
            # Add video track BEFORE creating answer to ensure ICE candidates are generated
            self.ball_generator = BallGenerator(width=640, height=480, fps=10)
            self.ball_generator.start()
            video_track = BallVideoTrack(self.ball_generator)
            pc.addTrack(video_track)
            logger.info("Video track added to peer connection")
            # Create answer
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            logger.info("Local description set")
            # Wait for ICE gathering to complete
            await self._wait_for_ice_gathering(pc)
            # Get the final answer with all candidates embedded
            final_answer = pc.localDescription
            logger.info("SDP answer created with all ICE candidates embedded")
            # Send answer back via WebTransport
            answer_message = {
                'type': 'answer',
                'sdp': final_answer.sdp
            }
            # Create a new unidirectional stream to send the answer
            try:
                stream_id = self._http.create_webtransport_stream(
                    self._session_id, 
                    is_unidirectional=True
                )
                answer_data = json.dumps(answer_message).encode()
                self._http._quic.send_stream_data(stream_id, answer_data, end_stream=True)
                logger.info("SDP answer sent")
            except Exception as e:
                logger.error(f"Failed to send SDP answer: {e}")
        except Exception as e:
            logger.error(f"Error handling SDP offer: {e}")
            import traceback
            traceback.print_exc()
        finally:
            async with self._state_lock:
                self._offer_in_progress = False
    
    async def _wait_for_ice_gathering(self, pc):
        if pc.iceGatheringState == 'complete':
            return
        
        logger.info("Waiting for ICE gathering to complete...")
        
        # Wait for ICE gathering to complete
        while pc.iceGatheringState != 'complete':
            await asyncio.sleep(0.1)
        
        logger.info("ICE gathering completed")
    
    async def start_video_stream(self):
        async with self._video_stream_lock:
            if self.video_task is None:
                self.video_task = asyncio.create_task(self._stream_video())
                logger.info("Video streaming started")
    
    async def stop_video_stream(self):
        async with self._video_stream_lock:
            if self.video_task:
                self.video_task.cancel()
                self.video_task = None
                logger.info("Video streaming stopped")
            
            if self.ball_generator:
                self.ball_generator.stop()
                self.ball_generator = None
                logger.info("Ball generator stopped")
    
    async def _stream_video(self):
        """Stream video frames"""
        try:
            while True:
                await asyncio.sleep(0.1) 
        except asyncio.CancelledError:
            logger.info("Video streaming cancelled")
        except Exception as e:
            logger.error(f"Error in video streaming: {e}")

    async def handle_client_coords(self, message):
        try:
            x = message.get('x')
            y = message.get('y')
            
            if x is None or y is None:
                logger.warning("Received coords missing x or y")
                return
            # Get the true ball center from the ball generator
            if self.ball_generator and self.ball_generator.running:
                true_x = int(self.ball_generator.ball_x)
                true_y = int(self.ball_generator.ball_y)
                error = ((x - true_x) ** 2 + (y - true_y) ** 2) ** 0.5 # error: distance between client and true ball center
                logger.info(f"Error: {error:.2f} (client: ({x},{y}), true: ({true_x},{true_y}))")
            else:
                error = None
                logger.warning("Ball generator not running, cannot compute error")
            # Send error back to client
            error_message = {
                'type': 'error',
                'error': error if error is not None else 'N/A',
                'client_x': x,
                'client_y': y,
                'true_x': true_x if self.ball_generator and self.ball_generator.running else None,
                'true_y': true_y if self.ball_generator and self.ball_generator.running else None
            }
            try:
                stream_id = self._http.create_webtransport_stream(
                    self._session_id,
                    is_unidirectional=True
                )
                self._http._quic.send_stream_data(stream_id, json.dumps(error_message).encode(), end_stream=True)
            except Exception as e:
                logger.error(f"Failed to send error message: {e}")
        except Exception as e:
            logger.error(f"Error in handle_client_coords: {e}")

    async def cleanup(self):
        logger.info("WebRtcHandler cleanup: Cancelling all pending tasks and closing peer connection.")
        # Cancel all tasks safely
        async with self._state_lock:
            tasks_to_cancel = list(self._tasks)
            self._tasks.clear()
        
        for task in tasks_to_cancel:
            try:
                task.cancel()
            except Exception as e:
                logger.error(f"Error cancelling task: {e}")
        
        try:
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)
        except Exception as e:
            logger.error(f"Error during task cleanup: {e}")
        
        async with self._state_lock:
            if self.peer_connection:
                try:
                    await self.peer_connection.close()
                except Exception as e:
                    logger.error(f"Error closing peer connection during cleanup: {e}")
            await self.stop_video_stream()


class BallVideoTrack(MediaStreamTrack):

    kind = "video"
    
    def __init__(self, ball_generator):
        super().__init__()
        self.ball_generator = ball_generator
        self.frame_count = 0
        self.start_time = time.time()
        logger.info("BallVideoTrack initialized")
    
    async def recv(self):
        try:
            current_time = time.time()
            frame_time = 1.0 / 10 
            expected_frame = int((current_time - self.start_time) / frame_time)
            
            # Check if ball generator is running and available
            if self.ball_generator and self.ball_generator.running:
                frame = self.ball_generator.get_frame()
            else:
                frame = None
                
            if frame is None:
                # Create a blank frame if no frame available
                img = Image.new('RGB', (640, 480), (50, 50, 50))
                draw = ImageDraw.Draw(img)
                left_up = (320 - 20, 240 - 20)
                right_down = (320 + 20, 240 + 20)
                draw.ellipse([left_up, right_down], fill=(0, 255, 0))
                frame = np.array(img)
            
            # Convert frame to RGB if needed (Pillow already gives RGB)
            frame_rgb = frame

            video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
            video_frame.pts = expected_frame
            video_frame.time_base = fractions.Fraction(1, 10) 
            
            self.frame_count += 1
            return video_frame
        except Exception as e:
            logger.error(f"Error in BallVideoTrack.recv: {e}")
            # Return a fallback frame on error
            try:
                img = Image.new('RGB', (640, 480), (50, 50, 50))
                draw = ImageDraw.Draw(img)
                left_up = (320 - 20, 240 - 20)
                right_down = (320 + 20, 240 + 20)
                draw.ellipse([left_up, right_down], fill=(0, 255, 0))
                frame = np.array(img)
                video_frame = VideoFrame.from_ndarray(frame, format="rgb24")
                video_frame.pts = self.frame_count
                video_frame.time_base = fractions.Fraction(1, 10)
                self.frame_count += 1
                return video_frame
            except Exception as fallback_error:
                logger.error(f"Error creating fallback frame: {fallback_error}")
                raise 