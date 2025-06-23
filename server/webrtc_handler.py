#!/usr/bin/env python3
"""
WebRTC Handler Module
Handles WebRTC connections and signaling
"""

import asyncio
import json
import logging
from typing import Optional
import aiortc
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack, RTCConfiguration, RTCIceServer
from av import VideoFrame
import fractions
import numpy as np
import cv2
import time

from .ball_generator import BallGenerator

logger = logging.getLogger(__name__)

class WebRtcHandler:
    """Handles WebRTC connections and signaling"""
    
    def __init__(self, session_id: int, http_connection):
        self._session_id = session_id
        self._http = http_connection
        self._stream_buffers = {}
        self.peer_connection = None
        self.ball_generator = None
        self.video_task = None
        self._tasks = set()  # Track all created asyncio tasks
        
        # Configure ICE servers for the server
        self.ice_servers = [
            RTCIceServer("stun:stun.l.google.com:19302"),
            RTCIceServer("stun:stun1.l.google.com:19302"),
            RTCIceServer("stun:stun2.l.google.com:19302")
        ]
        self.rtc_config = RTCConfiguration(iceServers=self.ice_servers)
        
        logger.info(f"WebRtcHandler initialized for session: {session_id}")
    
    def h3_event_received(self, event):
        """Handle HTTP/3 events"""
        if hasattr(event, 'stream_id') and hasattr(event, 'data') and hasattr(event, 'stream_ended'):
            # Handle unidirectional stream data (SDP offer or coords)
            if event.stream_id not in self._stream_buffers:
                self._stream_buffers[event.stream_id] = bytearray()
            
            if event.data:
                self._stream_buffers[event.stream_id].extend(event.data)
            
            if event.stream_ended:
                logger.info(f"Stream {event.stream_id} ended, processing complete message")
                data = bytes(self._stream_buffers[event.stream_id])
                
                # Try to parse as JSON to determine message type
                try:
                    message = json.loads(data.decode())
                    message_type = message.get('type', 'unknown')
                    
                    if message_type == 'offer':
                        logger.info("Processing SDP offer")
                        task = asyncio.create_task(self.handle_sdp_offer(data))
                        self._tasks.add(task)
                        task.add_done_callback(self._tasks.discard)
                    elif message_type == 'coords':
                        logger.info(f"Received coords from client: {message}")
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
    
    def stream_closed(self, stream_id: int):
        """Handle stream closure"""
        try:
            if stream_id in self._stream_buffers:
                del self._stream_buffers[stream_id]
        except KeyError:
            pass
    
    async def handle_sdp_offer(self, raw_data: bytes):
        """Handle WebRTC SDP offer and create answer"""
        try:
            data = json.loads(raw_data.decode())
            logger.info(f"Processing SDP offer: {data.get('type', 'unknown')}")
            
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
                logger.info(f"Connection state: {pc.connectionState}")
                if pc.connectionState == "connected":
                    logger.info("WebRTC connection established")
                    await self.start_video_stream()
                elif pc.connectionState in ["failed", "closed"]:
                    logger.info("WebRTC connection closed")
                    await self.stop_video_stream()
                    await pc.close()
            
            @pc.on("iceconnectionstatechange")
            async def on_iceconnectionstatechange():
                logger.info(f"ICE connection state: {pc.iceConnectionState}")
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
            
            @pc.on("track")
            async def on_track(track: MediaStreamTrack):
                logger.info(f"Received track: {track.kind}")
                if track.kind == "video":
                    logger.info("Video track received")
            
            # Set remote description (the offer)
            await pc.setRemoteDescription(offer)
            logger.info("Remote description set")
            
            # Add video track BEFORE creating answer to ensure ICE candidates are generated
            self.ball_generator = BallGenerator(width=640, height=480, fps=30)  # Reduced to 10 FPS
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
            stream_id = self._http.create_webtransport_stream(
                self._session_id, 
                is_unidirectional=True
            )
            answer_data = json.dumps(answer_message).encode()
            self._http._quic.send_stream_data(stream_id, answer_data, end_stream=True)
            logger.info("SDP answer sent via stream")
            
        except Exception as e:
            logger.error(f"Error handling SDP offer: {e}")
            import traceback
            traceback.print_exc()
    
    async def _wait_for_ice_gathering(self, pc):
        """Wait for ICE gathering to complete"""
        if pc.iceGatheringState == 'complete':
            logger.info("ICE gathering already complete")
            return
        
        logger.info("Waiting for ICE gathering to complete...")
        
        # Wait for ICE gathering to complete
        while pc.iceGatheringState != 'complete':
            await asyncio.sleep(0.1)
        
        logger.info("ICE gathering completed")
    
    async def start_video_stream(self):
        """Start video streaming"""
        if self.video_task is None:
            self.video_task = asyncio.create_task(self._stream_video())
            logger.info("Video streaming started")
    
    async def stop_video_stream(self):
        """Stop video streaming"""
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
                await asyncio.sleep(0.1)  # 10 FPS
        except asyncio.CancelledError:
            logger.info("Video streaming cancelled")
        except Exception as e:
            logger.error(f"Error in video streaming: {e}")

    async def handle_client_coords(self, message):
        """Compute error and send it back to the client via WebTransport"""
        try:
            x = message.get('x')
            y = message.get('y')
            logger.info(f"handle_client_coords: received coords from client: x={x}, y={y}")
            if x is None or y is None:
                logger.warning("Received coords missing x or y")
                return
            # Get the true ball center from the ball generator
            if self.ball_generator:
                true_x = int(self.ball_generator.ball_x)
                true_y = int(self.ball_generator.ball_y)
                error = ((x - true_x) ** 2 + (y - true_y) ** 2) ** 0.5
                logger.info(f"Computed error: {error:.2f} (client: ({x},{y}), true: ({true_x},{true_y}))")
            else:
                error = None
                logger.warning("Ball generator not running, cannot compute error")
            # Send error back to client
            error_message = {
                'type': 'error',
                'error': error if error is not None else 'N/A',
                'client_x': x,
                'client_y': y,
                'true_x': true_x if self.ball_generator else None,
                'true_y': true_y if self.ball_generator else None
            }
            logger.info(f"Sending error message to client: {error_message}")
            stream_id = self._http.create_webtransport_stream(
                self._session_id,
                is_unidirectional=True
            )
            self._http._quic.send_stream_data(stream_id, json.dumps(error_message).encode(), end_stream=True)
        except Exception as e:
            logger.error(f"Error in handle_client_coords: {e}")

    async def cleanup(self):
        """Cancel all pending tasks and close peer connection cleanly."""
        logger.info("WebRtcHandler cleanup: Cancelling all pending tasks and closing peer connection.")
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if self.peer_connection:
            await self.peer_connection.close()
        await self.stop_video_stream()


class BallVideoTrack(MediaStreamTrack):
    """Custom video track for streaming ball animation"""
    kind = "video"
    
    def __init__(self, ball_generator):
        super().__init__()
        self.ball_generator = ball_generator
        self.frame_count = 0
        self.start_time = time.time()
        logger.info("BallVideoTrack initialized")
    
    async def recv(self):
        # Calculate proper timing
        current_time = time.time()
        frame_time = 1.0 / 10  # 10 FPS
        expected_frame = int((current_time - self.start_time) / frame_time)
        
        # Get frame from ball generator
        frame = self.ball_generator.get_frame()
        if frame is None:
            # Create a blank frame if no frame available
            frame = np.full((480, 640, 3), (50, 50, 50), dtype=np.uint8)
            # Draw a static ball in the center
            cv2.circle(frame, (320, 240), 20, (0, 255, 0), -1)
        
        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Create VideoFrame with proper timing
        video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = expected_frame
        video_frame.time_base = fractions.Fraction(1, 10)  # 10 FPS time base
        
        # Log every 30 frames to track progress
        if self.frame_count % 30 == 0:
            logger.info(f"BallVideoTrack: sent frame {self.frame_count}, pts={video_frame.pts}")
        
        self.frame_count += 1
        return video_frame 