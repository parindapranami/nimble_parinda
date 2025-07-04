import asyncio
import logging
import ssl
import sys
import os
import argparse
import signal

from aioquic.asyncio import serve
from aioquic.quic.configuration import QuicConfiguration

from .webrtc_handler import WebTransportProtocol

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logging.getLogger('aiortc').setLevel(logging.WARNING)
logging.getLogger('aioice').setLevel(logging.WARNING)
logging.getLogger('quic').setLevel(logging.WARNING)

logger = logging.getLogger(__name__)

async def main():
    parser = argparse.ArgumentParser(description='WebTransport server')
    parser.add_argument('--cert', type=str, required=True)
    parser.add_argument('--key', type=str, required=True)
    parser.add_argument('--host', type=str, default='localhost')
    parser.add_argument('--port', type=int, default=4433)
    
    args = parser.parse_args()
    
    cert_file = args.cert
    key_file = args.key
    
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        logger.error(f"Certificate files not found: {cert_file}, {key_file}")
        sys.exit(1)
    
    quic_config = QuicConfiguration(
        is_client=False,
        alpn_protocols=["h3"],
    )
    
    try:
        quic_config.load_cert_chain(cert_file, key_file)
        logger.info("Certificates loaded")
    except Exception as e:
        logger.error(f"Error loading certificates: {e}")
        sys.exit(1)
    
    host = args.host
    port = args.port
    
    logger.info(f"Starting server on {host}:{port}")
    
    stop_event = asyncio.Event()

    def handle_signal():
        logger.info("Shutdown signal received")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_signal)
        except NotImplementedError:
            pass

    try:
        server = await serve(
            host,
            port,
            configuration=quic_config,
            create_protocol=WebTransportProtocol,
        )
        
        logger.info("Server started")

        await stop_event.wait()
        logger.info("Shutting down...")
        server.close()
 
        for protocol in list(server._protocols):
            handler = getattr(protocol, '_handler', None)
            if handler and hasattr(handler, 'cleanup'):
                await handler.cleanup()

        await asyncio.sleep(0.5)
        
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