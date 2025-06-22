#!/usr/bin/env python3
"""
Ball Generator Module
Generates bouncing ball frames in a separate thread
"""

import threading
import time
import numpy as np
import cv2
from queue import Queue
import logging

logger = logging.getLogger(__name__)

class BallGenerator:
    """Generates bouncing ball frames in a separate thread"""
    
    def __init__(self, width=640, height=480, fps=10):  # Reduced from 30 to 10 FPS
        self.width = width
        self.height = height
        self.fps = fps
        self.frame_queue = Queue(maxsize=60)  # Increased buffer size
        self.running = False
        self.thread = None
        self.frame_count = 0
        
        # Ball properties
        self.ball_x = width // 2
        self.ball_y = height // 2
        self.ball_vx = 2  # Reduced speed
        self.ball_vy = 1  # Reduced speed
        self.ball_radius = 20
        
        # Colors (BGR format for OpenCV)
        self.background_color = (50, 50, 50)  # Dark gray
        self.ball_color = (0, 255, 0)  # Green ball
        
        logger.debug(f"BallGenerator initialized: {width}x{height} @ {fps}fps")
        
    def start(self):
        """Start the ball generation thread"""
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._generate_frames, daemon=True)
            self.thread.start()
            logger.info(f"Ball generator started at {self.fps} FPS")
        else:
            logger.debug("Ball generator already running")
    
    def stop(self):
        """Stop the ball generation thread"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=1.0)
        logger.info("Ball generator stopped")
    
    def set_fps(self, fps):
        """Change the frame rate"""
        self.fps = fps
        logger.info(f"Frame rate changed to {self.fps} FPS")
    
    def set_ball_speed(self, vx, vy):
        """Change ball movement speed"""
        self.ball_vx = vx
        self.ball_vy = vy
        logger.info(f"Ball speed changed to vx={vx}, vy={vy}")
    
    def set_ball_size(self, radius):
        """Change ball size"""
        self.ball_radius = radius
        logger.info(f"Ball size changed to radius={radius}")
    
    def _generate_frames(self):
        """Generate frames in a separate thread"""
        logger.debug("Ball generator thread started")
        frame_time = 1.0 / self.fps
        
        while self.running:
            start_time = time.time()
            
            # Create frame
            frame = self._create_frame()
            self.frame_count += 1
            
            # Add to queue with better management
            if self.frame_queue.qsize() >= self.frame_queue.maxsize * 0.8:  # 80% full
                # Remove oldest frame to make room
                try:
                    self.frame_queue.get_nowait()
                except:
                    pass
            
            try:
                self.frame_queue.put_nowait(frame)
            except:
                pass
            
            # Sleep to maintain frame rate
            elapsed = time.time() - start_time
            if elapsed < frame_time:
                time.sleep(frame_time - elapsed)
        
        logger.debug("Ball generator thread stopped")
    
    def _create_frame(self):
        """Create a single frame with bouncing ball"""
        # Create blank frame
        frame = np.full((self.height, self.width, 3), self.background_color, dtype=np.uint8)
        
        # Update ball position
        self.ball_x += self.ball_vx
        self.ball_y += self.ball_vy
        
        # Bounce off walls
        if self.ball_x - self.ball_radius <= 0 or self.ball_x + self.ball_radius >= self.width:
            self.ball_vx = -self.ball_vx
        if self.ball_y - self.ball_radius <= 0 or self.ball_y + self.ball_radius >= self.height:
            self.ball_vy = -self.ball_vy
        
        # Keep ball in bounds
        self.ball_x = max(self.ball_radius, min(self.width - self.ball_radius, self.ball_x))
        self.ball_y = max(self.ball_radius, min(self.height - self.ball_radius, self.ball_y))
        
        # Draw ball (simple circle)
        cv2.circle(frame, (int(self.ball_x), int(self.ball_y)), self.ball_radius, self.ball_color, -1)
        
        return frame
    
    def get_frame(self):
        """Get the latest frame (non-blocking)"""
        try:
            frame = self.frame_queue.get_nowait()
            return frame
        except:
            # No frame available, create a fallback frame
            fallback_frame = np.full((self.height, self.width, 3), self.background_color, dtype=np.uint8)
            # Draw a static ball in the center
            cv2.circle(fallback_frame, (self.width // 2, self.height // 2), self.ball_radius, self.ball_color, -1)
            return fallback_frame
    
    def get_stats(self):
        """Get current statistics"""
        return {
            'fps': self.fps,
            'frame_queue_size': self.frame_queue.qsize(),
            'ball_position': (self.ball_x, self.ball_y),
            'ball_velocity': (self.ball_vx, self.ball_vy),
            'ball_radius': self.ball_radius,
            'resolution': (self.width, self.height),
            'running': self.running,
            'total_frames_generated': self.frame_count
        } 