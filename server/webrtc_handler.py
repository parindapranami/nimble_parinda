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
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import VideoFrame
import fractions
import numpy as np
import cv2

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
        logger.info(f"WebRtcHandler initialized for session: {session_id}")
    
    def h3_event_received(self, event):
        """Handle HTTP/3 events"""
        if hasattr(event, 'stream_id') and hasattr(event, 'data') and hasattr(event, 'stream_ended'):
            # Handle unidirectional stream data (SDP offer or ICE candidates)
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
                        asyncio.create_task(self.handle_sdp_offer(data))
                    elif message_type == 'ice-candidate':
                        logger.info("Processing ICE candidate")
                        asyncio.create_task(self.handle_ice_candidate(data))
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
            
            # Create RTCPeerConnection
            offer = RTCSessionDescription(sdp=data['sdp'], type=data['type'])
            pc = RTCPeerConnection()
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
                elif pc.iceConnectionState in ["failed", "closed"]:
                    logger.info("ICE connection failed/closed")
                    await self.stop_video_stream()
            
            @pc.on("icecandidate")
            async def on_icecandidate(candidate):
                if candidate:
                    logger.info(f"Generated ICE candidate: {candidate.candidate}")
                    # Send ICE candidate to client asynchronously
                    asyncio.create_task(self.send_ice_candidate(candidate))
                else:
                    logger.info("ICE candidate gathering complete")
            
            @pc.on("track")
            async def on_track(track: MediaStreamTrack):
                logger.info(f"Received track: {track.kind}")
                if track.kind == "video":
                    logger.info("Video track received")
            
            # Set remote description (the offer)
            await pc.setRemoteDescription(offer)
            logger.info("Remote description set")
            
            # Add video track BEFORE creating answer to ensure ICE candidates are generated
            logger.debug("Creating BallVideoTrack for SDP answer")
            self.ball_generator = BallGenerator(width=640, height=480, fps=30)
            self.ball_generator.start()
            
            video_track = BallVideoTrack(self.ball_generator)
            logger.debug("Adding video track to peer connection")
            pc.addTrack(video_track)
            logger.info("Video track added to peer connection")
            
            # Create answer
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            logger.info("Local description set")
            
            # Send answer back via WebTransport IMMEDIATELY
            # Don't wait for any ICE candidate generation
            answer_message = {
                'type': 'answer',
                'sdp': answer.sdp
            }
            
            # Create a new unidirectional stream to send the answer
            stream_id = self._http.create_webtransport_stream(
                self._session_id, 
                is_unidirectional=True
            )
            answer_data = json.dumps(answer_message).encode()
            self._http._quic.send_stream_data(stream_id, answer_data, end_stream=True)
            logger.info("SDP answer sent via stream IMMEDIATELY")
            
        except Exception as e:
            logger.error(f"Error handling SDP offer: {e}")
            import traceback
            traceback.print_exc()
    
    async def send_ice_candidate(self, candidate):
        """Send ICE candidate to client"""
        try:
            candidate_message = {
                'type': 'ice-candidate',
                'candidate': candidate.candidate,
                'sdpMid': candidate.sdpMid,
                'sdpMLineIndex': candidate.sdpMLineIndex
            }
            
            # Create a new unidirectional stream to send the ICE candidate
            stream_id = self._http.create_webtransport_stream(
                self._session_id, 
                is_unidirectional=True
            )
            candidate_data = json.dumps(candidate_message).encode()
            self._http._quic.send_stream_data(stream_id, candidate_data, end_stream=True)
            logger.info(f"ICE candidate sent: {candidate.candidate}")
            
        except Exception as e:
            logger.error(f"Error sending ICE candidate: {e}")
    
    async def handle_ice_candidate(self, raw_data: bytes):
        """Handle ICE candidate from client"""
        try:
            data = json.loads(raw_data.decode())
            logger.info(f"Received ICE candidate: {data.get('candidate', 'unknown')}")
            
            if self.peer_connection:
                # Parse the candidate string to extract components
                candidate_str = data['candidate']
                # For aiortc, we need to parse the candidate string manually
                # Format: candidate:foundation component protocol priority ip port typ [raddr rport] [generation] [ufrag] [network-cost]
                parts = candidate_str.split()
                if len(parts) >= 8 and parts[0].startswith('candidate:'):
                    foundation = parts[0][10:]  # Remove 'candidate:' prefix
                    component = int(parts[1])
                    protocol = parts[2]
                    priority = int(parts[3])
                    ip = parts[4]
                    port = int(parts[5])
                    
                    # Find the 'typ' field
                    typ = None
                    for i, part in enumerate(parts):
                        if part == 'typ' and i + 1 < len(parts):
                            typ = parts[i + 1]
                            break
                    
                    if typ:
                        candidate = aiortc.RTCIceCandidate(
                            component=component,
                            foundation=foundation,
                            ip=ip,
                            port=port,
                            priority=priority,
                            protocol=protocol,
                            type=typ,
                            sdpMid=data['sdpMid'],
                            sdpMLineIndex=data['sdpMLineIndex']
                        )
                        await self.peer_connection.addIceCandidate(candidate)
                        logger.info("ICE candidate added to peer connection")
                    else:
                        logger.warning(f"Could not find 'typ' field in ICE candidate: {candidate_str}")
                else:
                    logger.warning(f"Invalid ICE candidate format: {candidate_str}")
            else:
                logger.warning("No peer connection available for ICE candidate")
                
        except Exception as e:
            logger.error(f"Error handling ICE candidate: {e}")
            import traceback
            traceback.print_exc()
    
    async def start_video_stream(self):
        """Start the video streaming task"""
        logger.debug("start_video_stream() called")
        if self.video_task is None:
            logger.debug("BallGenerator already exists, creating video streaming task")
            self.video_task = asyncio.create_task(self._stream_video())
            logger.info("Video streaming started")
        else:
            logger.debug("Video task already exists, skipping")
    
    async def stop_video_stream(self):
        """Stop the video streaming task"""
        logger.debug("stop_video_stream() called")
        if self.video_task:
            logger.debug("Cancelling video task")
            self.video_task.cancel()
            self.video_task = None
        
        if self.ball_generator:
            logger.debug("Stopping ball generator")
            self.ball_generator.stop()
            self.ball_generator = None
        
        logger.info("Video streaming stopped")
    
    async def _stream_video(self):
        """Stream video frames over WebRTC"""
        logger.debug("_stream_video() started")
        try:
            # Video track is already added to peer connection in handle_sdp_offer
            # Just keep the task running to maintain the ball generator
            logger.debug("Video streaming task running, waiting...")
            while True:
                await asyncio.sleep(1)
                
        except asyncio.CancelledError:
            logger.info("Video streaming task cancelled")
        except Exception as e:
            logger.error(f"Error in video streaming: {e}")
            import traceback
            traceback.print_exc()


class BallVideoTrack(MediaStreamTrack):
    """Custom video track for streaming ball animation"""
    kind = "video"
    
    def __init__(self, ball_generator):
        super().__init__()
        self.ball_generator = ball_generator
        self.frame_count = 0
        logger.debug("BallVideoTrack initialized")
    
    async def recv(self):
        logger.debug(f"BallVideoTrack.recv() called, frame_count={self.frame_count}")
        # Get frame from ball generator
        frame = self.ball_generator.get_frame()
        if frame is None:
            logger.debug("No frame available from ball generator, creating blank frame")
            # Create a blank frame if no frame available
            frame = np.full((480, 640, 3), (50, 50, 50), dtype=np.uint8)
        else:
            logger.debug(f"Got frame from ball generator, shape={frame.shape}")
        
        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        logger.debug(f"Converted frame to RGB, shape={frame_rgb.shape}")
        
        # Create VideoFrame
        video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = self.frame_count
        video_frame.time_base = fractions.Fraction(1, 30)
        logger.debug(f"Created VideoFrame, pts={video_frame.pts}")
        
        self.frame_count += 1
        return video_frame 