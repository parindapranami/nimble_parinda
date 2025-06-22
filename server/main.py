#!/usr/bin/env python3
"""
WebTransport + WebRTC Server Main Entry Point
"""

import asyncio
import logging
import ssl
import sys
import os
import argparse

from aioquic.asyncio import serve
from aioquic.quic.configuration import QuicConfiguration

from .protocol import WebTransportProtocol

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Reduce verbose logging from external libraries
logging.getLogger('aiortc').setLevel(logging.WARNING)
logging.getLogger('aioice').setLevel(logging.WARNING)
logging.getLogger('quic').setLevel(logging.WARNING)

logger = logging.getLogger(__name__)

async def main():
    """Main server function"""
    parser = argparse.ArgumentParser(description='WebTransport server')
    parser.add_argument('--cert', type=str, required=True)
    parser.add_argument('--key', type=str, required=True)
    parser.add_argument('--host', type=str, default='localhost')
    parser.add_argument('--port', type=int, default=4433)
    
    args = parser.parse_args()
    
    # Load SSL certificate and key
    cert_file = args.cert
    key_file = args.key
    
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        logger.error(f"SSL certificate files not found: {cert_file}, {key_file}")
        sys.exit(1)
    
    # Create QUIC configuration
    quic_config = QuicConfiguration(
        is_client=False,
        alpn_protocols=["h3"],
    )
    
    # Load certificates
    try:
        quic_config.load_cert_chain(cert_file, key_file)
        logger.info("Certificates loaded successfully")
    except Exception as e:
        logger.error(f"Error loading certificates: {e}")
        sys.exit(1)
    
    # Create server
    host = args.host
    port = args.port
    
    logger.info(f"Starting WebTransport server on {host}:{port}")
    
    try:
        await serve(
            host,
            port,
            configuration=quic_config,
            create_protocol=WebTransportProtocol,
        )
        logger.info("Server started successfully")
        
        # Keep the server running
        await asyncio.Future() 
        
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1) 