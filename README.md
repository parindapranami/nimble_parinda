# WebRTC + WebTransport Bouncing Ball Application

A real-time video streaming application using WebRTC and WebTransport to display a bouncing ball with client-side ball tracking and server-side error feedback.

## Features

- **Real-time Video Streaming**: WebRTC video stream with H.264 encoding
- **Ball Tracking**: Client-side green ball detection and coordinate estimation
- **Error Feedback**: Server-side error calculation and feedback
- **WebTransport**: Modern transport protocol for signaling
- **Docker Support**: Containerized deployment
- **Unit Tests**: Comprehensive test coverage

## Project Structure

```
Nimble/
├── client/                 # Web client (HTML, CSS, JS)
├── server/                 # Python WebRTC server
│   ├── main.py            # Server entry point
│   ├── webrtc_handler.py  # WebRTC connection handling
│   └── ball_generator.py  # Bouncing ball video generation
├── tests/                  # Unit tests
├── Dockerfile             # Production Docker image
├── docker-compose.yml     # Docker deployment
└── requirements.txt       # Python dependencies
```

## Quick Start

### Prerequisites

- Python 3.11+
- Docker (optional)

### Local Development

1. **Install dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

2. **Generate SSL certificates:**

   ```bash
   ./generate_certs.sh
   ```

3. **Run tests:**

   ```bash
   pytest -v tests/
   ```

4. **Start server:**

   ```bash
   python -m server.main --cert certs/cert.pem --key certs/key.pem
   ```

5. **Open client:**
   - Navigate to `client/index.html` in your browser
   - Click "Connect" to start the WebRTC connection

### Docker Deployment

1. **Build and run with Docker Compose:**

   ```bash
   docker-compose up --build
   ```

2. **Run tests in Docker:**
   ```bash
   docker-compose --profile test up webrtc-tests
   ```

## Testing

The project includes comprehensive unit tests:

- **BallGenerator**: Tests ball animation and frame generation
- **WebRtcHandler**: Tests WebRTC connection handling
- **BallVideoTrack**: Tests video frame generation

Run tests with:

```bash
pytest -v tests/
```

## Technologies Used

- **Backend**: Python, asyncio, aiortc, aioquic
- **Frontend**: HTML5, CSS3, JavaScript, WebRTC API
- **Video**: OpenCV, H.264 encoding
- **Transport**: WebTransport over QUIC
- **Testing**: pytest, pytest-asyncio
- **Deployment**: Docker, Docker Compose

## License

This project is part of the Nimble Programming Challenge 2025.
