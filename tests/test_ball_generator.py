import pytest
import numpy as np
from server.ball_generator import BallGenerator

def test_ball_generator_start_stop():
    gen = BallGenerator(width=320, height=240, fps=5)
    gen.start()
    assert gen.running
    gen.stop()
    assert not gen.running

def test_ball_generator_frame_shape():
    gen = BallGenerator(width=100, height=80, fps=2)
    gen.start()
    frame = gen.get_frame()
    assert isinstance(frame, np.ndarray)
    assert frame.shape == (80, 100, 3)
    gen.stop()

def test_ball_generator_stats():
    gen = BallGenerator(width=50, height=50, fps=1)
    gen.start()
    stats = gen.get_stats()
    assert stats['fps'] == 1
    assert stats['resolution'] == (50, 50)
    gen.stop() 