# This file generates bouncing ball frames in a separate thread

import threading
import time
import numpy as np
from PIL import Image, ImageDraw
from queue import Queue
import logging

logger = logging.getLogger(__name__)

class BallGenerator:

    def __init__(self, width=640, height=480, fps=30):  
        self.width = width
        self.height = height
        self.fps = fps
        self.frame_queue = Queue(maxsize=60)
        self.running = False
        self.thread = None
        self.frame_count = 0
        
        # Ball starting position and movement
        self.ball_x = width // 2
        self.ball_y = height // 2
        self.ball_vx = 2
        self.ball_vy = 1
        self.ball_radius = 25
        
        self.background_color = (50, 50, 50)
        self.ball_color = (0, 255, 0)
        
        logger.debug(f"BallGenerator initialized: {width}x{height} @ {self.fps}fps")
        
    def start(self):
        
        if not self.running:
            self.running = True
            self.thread = threading.Thread(target=self._generate_frames, daemon=True)
            self.thread.start()
            logger.info(f"Ball generator started at {self.fps} FPS")
        else:
            # logger.debug("Ball generator already running")
            pass
    
    def stop(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=1.0)
        logger.info("Ball generator stopped")
    
    def set_fps(self, fps):
        self.fps = fps
        logger.info(f"Frame rate changed to {self.fps} FPS")
    
    def _generate_frames(self):
        
        logger.debug("Ball generator thread started")
        frame_time = 1.0 / self.fps
        
        while self.running:
            start_time = time.time()
            
            frame = self._create_frame()
            self.frame_count += 1
            
            # Manage queue size
            if self.frame_queue.qsize() >= 25:
                try:
                    self.frame_queue.get_nowait()
                except:
                    pass
            
            try:
                self.frame_queue.put_nowait(frame)
            except:
                pass
            
            # Control frame rate
            elapsed = time.time() - start_time
            if elapsed < frame_time:
                time.sleep(frame_time - elapsed)
        
        logger.debug("Ball generator thread stopped")
    
    def _create_frame(self):
        # Create a PIL image with the background color
        img = Image.new('RGB', (self.width, self.height), self.background_color)
        draw = ImageDraw.Draw(img)

        # Move ball
        self.ball_x += self.ball_vx
        self.ball_y += self.ball_vy

        # Bounce off edges
        if self.ball_x - self.ball_radius <= 0 or self.ball_x + self.ball_radius >= self.width:
            self.ball_vx = -self.ball_vx
        if self.ball_y - self.ball_radius <= 0 or self.ball_y + self.ball_radius >= self.height:
            self.ball_vy = -self.ball_vy

        # Keep ball on screen
        self.ball_x = max(self.ball_radius, min(self.width - self.ball_radius, self.ball_x))
        self.ball_y = max(self.ball_radius, min(self.height - self.ball_radius, self.ball_y))

        # Draw the ball
        left_up = (int(self.ball_x - self.ball_radius), int(self.ball_y - self.ball_radius))
        right_down = (int(self.ball_x + self.ball_radius), int(self.ball_y + self.ball_radius))
        draw.ellipse([left_up, right_down], fill=self.ball_color)

        # Convert PIL image to numpy array
        frame = np.array(img)
        return frame
    
    def get_frame(self):
        try:
            frame = self.frame_queue.get_nowait()
            return frame
        except:
            # Create a simple frame if queue is empty
            img = Image.new('RGB', (self.width, self.height), self.background_color)
            draw = ImageDraw.Draw(img)
            left_up = (self.width // 2 - self.ball_radius, self.height // 2 - self.ball_radius)
            right_down = (self.width // 2 + self.ball_radius, self.height // 2 + self.ball_radius)
            draw.ellipse([left_up, right_down], fill=self.ball_color)
            fallback_frame = np.array(img)
            return fallback_frame
    
    def get_stats(self):
        return {
            'fps': self.fps,
            'queue_size': self.frame_queue.qsize(),
            'ball_pos': (self.ball_x, self.ball_y),
            'ball_vel': (self.ball_vx, self.ball_vy),
            'ball_radius': self.ball_radius,
            'resolution': (self.width, self.height),
            'running': self.running,
            'frames_generated': self.frame_count
        } 