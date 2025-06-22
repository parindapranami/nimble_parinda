#!/usr/bin/env python3
"""
WebTransport Protocol Module
Handles WebTransport over QUIC protocol
"""

import logging
from typing import Optional
from aioquic.asyncio import QuicConnectionProtocol
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import HeadersReceived, WebTransportStreamDataReceived, H3Event
from aioquic.quic.events import QuicEvent, ProtocolNegotiated, StreamReset

from .webrtc_handler import WebRtcHandler

logger = logging.getLogger(__name__)

class WebTransportProtocol(QuicConnectionProtocol):
    """Protocol for handling WebTransport over QUIC"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http: Optional[H3Connection] = None
        self._handler: Optional[WebRtcHandler] = None
    
    def quic_event_received(self, event: QuicEvent) -> None:
        """Handle QUIC events"""
        if isinstance(event, ProtocolNegotiated):
            self._http = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(event, StreamReset) and self._handler is not None:
            # Handle stream resets
            self._handler.stream_closed(event.stream_id)
        
        if self._http is not None:
            for h3_event in self._http.handle_event(event):
                self._h3_event_received(h3_event)
    
    def _h3_event_received(self, event: H3Event) -> None:
        """Handle HTTP/3 events"""
        if not self._http:
            return
            
        if isinstance(event, HeadersReceived):
            headers = dict(event.headers)
            method = headers.get(b":method")
            protocol = headers.get(b":protocol")
            path = headers.get(b":path")

            if method == b"CONNECT" and protocol == b"webtransport" and path == b"/connection":
                logger.info("WebTransport handshake received, accepting connection")
                self._handler = WebRtcHandler(event.stream_id, self._http)
                self._http.send_headers(
                    stream_id=event.stream_id,
                    headers=[
                        (b":status", b"200"),
                        (b"sec-webtransport-http3-draft", b"draft02"),
                    ]
                )
        elif isinstance(event, WebTransportStreamDataReceived):
            # Handle unidirectional stream data (SDP offer or ICE candidates)
            pass
        
        if self._handler:
            self._handler.h3_event_received(event) 