import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from server.webrtc_handler import WebRtcHandler
import asyncio
import json

class DummyHttp:
    def create_webtransport_stream(self, session_id, is_unidirectional=True):
        return 1
    class _quic:
        @staticmethod
        def send_stream_data(stream_id, data, end_stream=True):
            pass

@pytest.mark.asyncio
async def test_handle_sdp_offer_invalid():
    handler = WebRtcHandler(1, DummyHttp())
    # Missing 'sdp' key
    bad_offer = b'{"type": "offer"}'
    await handler.handle_sdp_offer(bad_offer)
    assert handler.peer_connection is None

@pytest.mark.asyncio
async def test_handle_sdp_offer_valid():
    handler = WebRtcHandler(1, DummyHttp())
    valid_offer = b'{"type": "offer", "sdp": "v=0\\r\\no=- 1234567890 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=video 9 UDP/TLS/RTP/SAVPF 96\\r\\n"}'
    await handler.handle_sdp_offer(valid_offer)
    assert handler.peer_connection is not None

@pytest.mark.asyncio
async def test_stream_closed():
    handler = WebRtcHandler(1, DummyHttp())
    handler._stream_buffers[5] = b'data'
    handler.stream_closed(5)
    assert 5 not in handler._stream_buffers

@pytest.mark.asyncio
async def test_handle_client_coords_no_ball():
    handler = WebRtcHandler(1, DummyHttp())
    msg = {'x': 10, 'y': 20}
    await handler.handle_client_coords(msg)

@pytest.mark.asyncio
async def test_handle_client_coords_with_ball():
    handler = WebRtcHandler(1, DummyHttp())
    handler.ball_generator = MagicMock()
    handler.ball_generator.ball_x = 100
    handler.ball_generator.ball_y = 150
    
    msg = {'x': 110, 'y': 160}
    await handler.handle_client_coords(msg)
    
    expected_error = ((110 - 100) ** 2 + (160 - 150) ** 2) ** 0.5
    assert expected_error == 14.142135623730951 