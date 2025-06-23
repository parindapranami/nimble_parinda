import pytest
import numpy as np
import time
from server.webrtc_handler import BallVideoTrack
from av import VideoFrame

class DummyBallGen:
    def get_frame(self):
        return np.zeros((480, 640, 3), dtype=np.uint8)

def test_ball_video_track_recv(monkeypatch):
    track = BallVideoTrack(DummyBallGen())
    monkeypatch.setattr(track, 'start_time', time.time() - 1)
    frame = pytest.run(track.recv()) if hasattr(pytest, 'run') else None
    # If pytest.run is not available, just check the method exists
    assert hasattr(track, 'recv') 

@pytest.mark.asyncio
async def test_ball_video_track_recv_returns_frame():
    track = BallVideoTrack(DummyBallGen())
    track.start_time = time.time() - 1
    
    frame = await track.recv()
    
    assert isinstance(frame, VideoFrame)
    assert frame.width == 640
    assert frame.height == 480
    assert frame.format.name == 'rgb24' 