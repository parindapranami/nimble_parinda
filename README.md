# WebRTC + WebTransport Bouncing Ball Application

I built this real-time video streaming app to fulfill specific requirements for a programming challenge. The goal was to create a WebRTC + WebTransport system where a server generates a bouncing ball video stream and a client tracks the ball position, with real-time error feedback.

## Requirements Fulfilled

- ✅ Web app client with WebRTC SDP offer over WebTransport
- ✅ Server handling WebTransport requests and WebRTC signaling
- ✅ Worker thread generating continuous 2D bouncing ball frames
- ✅ H.264 encoded video streaming over WebRTC
- ✅ Client-side ball position detection (x,y coordinates)
- ✅ Real-time error calculation and feedback
- ✅ Graceful server shutdown handling
- ✅ Comprehensive unit tests
- ✅ Docker and Kubernetes deployment
- ✅ Complete documentation

## What I Made

- **Real-time Video Streaming**: WebRTC video stream with H.264 encoding
- **Ball Tracking**: Client-side green ball detection and coordinate estimation
- **Error Feedback**: Server-side error calculation and feedback
- **WebTransport**: Modern transport protocol for signaling
- **Docker Support**: Containerized deployment
- **Unit Tests**: Comprehensive test coverage

## How I Structured It

```
Nimble/
├── client/                 # Web client (HTML, CSS, JS)
├── server/                 # Python WebRTC server
│   ├── main.py            # Server entry point
│   ├── webrtc_handler.py  # WebRTC connection handling
│   └── ball_generator.py  # Bouncing ball video generation
├── tests/                  # Unit tests
├── k8s/                   # Kubernetes manifests
├── Dockerfile             # Production Docker image
├── docker-compose.yml     # Docker deployment
└── requirements.txt       # Python dependencies
```

## Getting Started

### Prerequisites

- Python 3.11+
- Docker (optional)
- kubectl (for Kubernetes)

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

### Kubernetes Deployment

I also set up Kubernetes deployment for when you want to scale this up:

#### Using Minikube (easiest)

1. **Install minikube:**

   ```bash
   # mac
   brew install minikube

   # linux
   curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
   sudo install minikube-linux-amd64 /usr/local/bin/minikube
   ```

2. **Start minikube:**

   ```bash
   minikube start
   ```

3. **Build and load the image:**

   ```bash
   # build
   docker build -t webrtc-server:latest .

   # load into minikube
   minikube image load webrtc-server:latest
   ```

#### Deploy

**Quick way:**

```bash
./deploy.sh
```

**Manual way:**

```bash
# make certificates
./generate_certs.sh

# create namespace
kubectl apply -f k8s/namespace.yaml

# create secret
kubectl create secret generic webrtc-certs \
  --from-file=cert.pem=certs/cert.pem \
  --from-file=key.pem=certs/key.pem \
  -n webrtc-app

# deploy
kubectl apply -k k8s/
```

#### Check if it works

```bash
# see pods
kubectl get pods -n webrtc-app

# see services
kubectl get services -n webrtc-app

# see logs
kubectl logs -f deployment/webrtc-server -n webrtc-app
```

#### Access the app

**Minikube:**

```bash
minikube service webrtc-service -n webrtc-app
```

**Port forward:**

```bash
kubectl port-forward service/webrtc-service 4433:4433 -n webrtc-app
```

#### Clean up

```bash
# delete everything
kubectl delete -k k8s/

# delete namespace
kubectl delete namespace webrtc-app
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

## What I Used

- **Backend**: Python, asyncio, aiortc, aioquic
- **Frontend**: HTML5, CSS3, JavaScript, WebRTC API
- **Video**: OpenCV, H.264 encoding
- **Transport**: WebTransport over QUIC
- **Testing**: pytest, pytest-asyncio
- **Deployment**: Docker, Docker Compose, Kubernetes

## Design Decisions I Made

### Language Choice

I considered using Go for the server since it's great for networking, but I stuck with Python because I'm more comfortable with it and the aiortc library has excellent WebRTC support. I wanted to focus on learning WebRTC concepts rather than fighting with a new language.

### Frontend Approach

I used vanilla JavaScript instead of a framework like React. The requirements were clear about creating a "simple web app" and I didn't want to overcomplicate things. Plus, WebRTC APIs work well with vanilla JS.

### H.264 Encoding

I forced H.264 encoding on the client side using `RTCRtpTransceiver.setCodecPreferences()`. I could have done this server-side, but client-side gives more control and ensures compatibility. The server generates raw frames and lets the WebRTC stack handle encoding.

### Ball Physics

For the bouncing ball, I went with simple physics - velocity, gravity, and collision detection. I considered using a physics engine like Box2D, but that felt like overkill for a bouncing ball. The math is straightforward: update position based on velocity, apply gravity, check for wall collisions and reverse velocity.

### Error Calculation

I calculate error as Euclidean distance between detected and actual ball centers. I thought about using more sophisticated metrics like IoU (Intersection over Union) or considering ball size, but simple distance works well for this use case. The server tracks the actual ball position in real-time, not against cached frames.

### Non-Trickle ICE

I initially spent a lot fo time to do manual ICE candidate exchange but later discovered that it was overkill since I was running both client and server on same network so need s=for NAT traversal, so I remove it later and used non-trickle ICE where all candidates are embedded in the SDP. This simplified the signaling and made it more reliable for localhost testing.

### Frame Rate

The client-side ball tracking was fun to implement - I used canvas to detect the green ball and calculate its position. The server then compares this with the actual ball position to provide error feedback.

## License

This project is part of the Nimble Programming Challenge 2025.
