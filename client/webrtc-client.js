/**
 * WebRTC + WebTransport Client JavaScript
 */

// Global variables
let webTransport = null;
let peerConnection = null;
let videoElement = null;
let statusDiv = null;
let connectBtn = null;
let disconnectBtn = null;
let logDiv = null;

// WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// Logging function
function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logDiv.innerHTML += `[${timestamp}] ${message}<br>`;
  logDiv.scrollTop = logDiv.scrollHeight;
  console.log(message);
}

// Update status
function updateStatus(status, className) {
  statusDiv.textContent = `Status: ${status}`;
  statusDiv.className = `status ${className}`;
}

// Connect to WebTransport and establish WebRTC
async function connect() {
  try {
    updateStatus("Connecting...", "connecting");
    connectBtn.disabled = true;

    log("Requirement 3: Creating WebRTC SDP offer...");
    log("Requirement 4: Establishing WebTransport connection to server");

    // Connect to WebTransport
    webTransport = new WebTransport("https://localhost:4433/connection");

    await webTransport.ready;
    log("Requirement 4: WebTransport connection established successfully");

    // Create WebRTC peer connection
    peerConnection = new RTCPeerConnection(rtcConfig);
    log("Requirement 3: WebRTC peer connection created");

    // Create offer
    log("Requirement 3: Creating SDP offer...");

    // Wait for all ICE candidates to be gathered before creating offer
    const offer = await peerConnection.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: false,
    });

    // Set local description to trigger ICE gathering
    await peerConnection.setLocalDescription(offer);

    // Wait for ICE gathering to complete
    await new Promise((resolve) => {
      if (peerConnection.iceGatheringState === "complete") {
        resolve();
      } else {
        peerConnection.onicecandidate = (event) => {
          if (!event.candidate) {
            // ICE gathering complete
            resolve();
          }
        };
      }
    });

    // Get the final offer with all candidates embedded
    const finalOffer = peerConnection.localDescription;
    log("Requirement 3: SDP offer created with all ICE candidates embedded");

    // Send offer via unidirectional stream
    const writer = (
      await webTransport.createUnidirectionalStream()
    ).getWriter();
    const encoder = new TextEncoder();

    const offerMessage = {
      type: "offer",
      sdp: finalOffer.sdp,
    };

    const offerData = encoder.encode(JSON.stringify(offerMessage));
    await writer.write(offerData);
    await writer.close();
    log("Requirement 3: SDP offer sent to server via WebTransport");

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
      log("Requirement 8: Received remote track from server");
      if (event.track.kind === "video") {
        log(
          "Requirement 8: Video track received, preparing to display in browser"
        );

        // Set video element properties
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true;
        videoElement.controls = false;

        // Attach the stream
        videoElement.srcObject = event.streams[0];
        log("Requirement 8a: Video stream attached to browser video element");

        // Add event listeners to video element
        videoElement.onloadedmetadata = () => {
          log(
            `Requirement 8a: Video ready for display: ${videoElement.videoWidth}x${videoElement.videoHeight}`
          );
          // Try to play immediately when metadata is loaded
          videoElement.play().catch((e) => log(`Auto-play failed: ${e}`));
        };

        videoElement.onplay = () => {
          log("Requirement 8a: Video playback started in browser");
        };

        videoElement.onerror = (e) => {
          log(`Video error: ${e}`);
        };

        videoElement.oncanplay = () => {
          log("Requirement 8a: Video can play in browser");
        };

        videoElement.onloadeddata = () => {
          log("Requirement 8a: Video data loaded in browser");
        };

        videoElement.onwaiting = () => {
          log("Video waiting for data");
        };

        videoElement.onplaying = () => {
          log("Requirement 8a: Video is playing in browser");
        };

        // Try to play the video immediately
        setTimeout(() => {
          videoElement
            .play()
            .then(() => {
              log("Requirement 8a: Video play() succeeded in browser");
            })
            .catch((error) => {
              log(`Video play() failed: ${error}`);
            });
        }, 100);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      log(`Connection state: ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === "connected") {
        updateStatus("Connected", "connected");
        disconnectBtn.disabled = false;
        log("Requirement 3: WebRTC connection established successfully");
        log("Requirement 4: WebTransport connection active");
        log("Ready to receive video stream from server");
      } else if (
        peerConnection.connectionState === "failed" ||
        peerConnection.connectionState === "closed"
      ) {
        updateStatus("Connection Failed", "disconnected");
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        log(`WebRTC connection ${peerConnection.connectionState}`);
      } else if (peerConnection.connectionState === "connecting") {
        log("WebRTC connecting...");
      }
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      log(`ICE connection state: ${peerConnection.iceConnectionState}`);
      if (peerConnection.iceConnectionState === "connected") {
        log("ICE connection established");
      } else if (
        peerConnection.iceConnectionState === "failed" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        log(`ICE connection ${peerConnection.iceConnectionState}`);
      } else if (peerConnection.iceConnectionState === "checking") {
        log("ICE checking...");
      }
    };

    // Handle signaling state changes
    peerConnection.onsignalingstatechange = () => {
      log(`Signaling state: ${peerConnection.signalingState}`);
    };

    // Read answer from incoming unidirectional stream
    const incomingStream =
      await webTransport.incomingUnidirectionalStreams.getReader();

    // Start handling incoming streams
    handleIncomingStreams(incomingStream);

    log("WebRTC connection established successfully");
  } catch (error) {
    log(`Error during connection: ${error.message}`);
    updateStatus("Connection Failed", "disconnected");
    connectBtn.disabled = false;
  }
}

// Function to handle incoming streams (SDP answer only)
async function handleIncomingStreams(incomingStream) {
  try {
    while (true) {
      const { value: stream, done } = await incomingStream.read();
      if (done) {
        log("Incoming stream reader done");
        break;
      }

      log("Requirement 5: Received incoming stream from server");
      const reader = stream.getReader();
      const { value: response } = await reader.read();
      const decoder = new TextDecoder();
      const data = JSON.parse(decoder.decode(response));

      if (data.type === "answer") {
        log("Requirement 5: Received SDP answer from server");
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data)
        );
        log("Requirement 5: Remote description set from server response");
      } else {
        log(`Unknown message type: ${data.type}`);
      }
    }
  } catch (error) {
    log(`Error handling incoming streams: ${error.message}`);

    // Check if it's a connection loss
    if (
      error.message.includes("Connection lost") ||
      error.message.includes("closed")
    ) {
      log("WebTransport connection lost");
      updateStatus("Connection Lost", "disconnected");
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
    }
  }
}

// Disconnect
async function disconnect() {
  try {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
      log("WebRTC connection closed");
    }

    if (webTransport) {
      webTransport.close();
      webTransport = null;
      log("WebTransport connection closed");
    }

    videoElement.srcObject = null;
    updateStatus("Disconnected", "disconnected");
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  } catch (error) {
    log(`Error during disconnect: ${error.message}`);
  }
}

// Initialize the client
function initializeClient() {
  videoElement = document.getElementById("videoElement");
  statusDiv = document.getElementById("status");
  connectBtn = document.getElementById("connectBtn");
  disconnectBtn = document.getElementById("disconnectBtn");
  logDiv = document.getElementById("log");

  // Handle page unload
  window.addEventListener("beforeunload", () => {
    disconnect();
  });

  log("=== Nimble Programming Challenge - 2025 ===");
  log("Requirement 1: Simple web app client initialized");
  log("Requirement 2: Client ready to connect to server");
  log("Click Connect to start WebRTC + WebTransport connection");
}

// Clear log function
function clearLog() {
  if (logDiv) {
    logDiv.innerHTML = "";
    log("Log cleared");
  }
}

// Export functions for global access
window.connect = connect;
window.disconnect = disconnect;
window.initializeClient = initializeClient;
window.clearLog = clearLog;
