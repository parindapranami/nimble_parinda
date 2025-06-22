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
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Logging function
function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logDiv.innerHTML += `[${timestamp}] ${message}\n`;
  logDiv.scrollTop = logDiv.scrollHeight;
  console.log(message);
}

// Debug logging function
function debug(message) {
  const timestamp = new Date().toLocaleTimeString();
  const debugMessage = `[DEBUG] ${message}`;
  logDiv.innerHTML += `[${timestamp}] ${debugMessage}\n`;
  logDiv.scrollTop = logDiv.scrollHeight;
  console.log(debugMessage);
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

    debug("Starting WebTransport connection...");

    // Connect to WebTransport
    webTransport = new WebTransport("https://localhost:4433/connection");
    debug("WebTransport object created");

    await webTransport.ready;
    debug("WebTransport ready event fired");
    log("WebTransport connected successfully");

    // Create WebRTC peer connection
    peerConnection = new RTCPeerConnection(rtcConfig);
    debug("RTCPeerConnection created");
    log("WebRTC peer connection created");

    // Create offer
    debug("Creating SDP offer...");
    log("Creating SDP offer...");
    const offer = await peerConnection.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: false,
    });
    debug(`SDP offer created: ${offer.sdp.substring(0, 100)}...`);

    await peerConnection.setLocalDescription(offer);
    debug("Local description set");
    log("SDP offer created and set as local description");

    // Send offer via unidirectional stream
    debug("Creating unidirectional stream for SDP offer");
    const writer = (
      await webTransport.createUnidirectionalStream()
    ).getWriter();
    const encoder = new TextEncoder();

    const offerMessage = {
      type: "offer",
      sdp: offer.sdp,
    };

    const offerData = encoder.encode(JSON.stringify(offerMessage));
    debug(`Sending SDP offer, size: ${offerData.length} bytes`);
    await writer.write(offerData);
    await writer.close();
    debug("SDP offer sent and stream closed");
    log("SDP offer sent via unidirectional stream");

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
      debug(
        `ontrack event fired: kind=${event.track.kind}, id=${event.track.id}`
      );
      log("Received remote track");
      if (event.track.kind === "video") {
        debug("Video track received, attaching to video element");
        videoElement.srcObject = event.streams[0];
        debug(`Video stream attached, streams length: ${event.streams.length}`);
        log("Video stream attached to video element");

        // Add event listeners to video element
        videoElement.onloadedmetadata = () => {
          debug(
            `Video metadata loaded: ${videoElement.videoWidth}x${videoElement.videoHeight}`
          );
        };
        videoElement.onplay = () => {
          debug("Video started playing");
        };
        videoElement.onerror = (e) => {
          debug(`Video error: ${e}`);
        };
      }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        debug(`ICE candidate generated: ${event.candidate.candidate}`);
        log("Generated ICE candidate");
        // Send ICE candidate to server
        sendIceCandidate(event.candidate);
      } else {
        debug("ICE candidate gathering complete");
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      debug(`Connection state changed: ${peerConnection.connectionState}`);
      log(`Connection state: ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === "connected") {
        debug("WebRTC connection established successfully");
        updateStatus("Connected", "connected");
        disconnectBtn.disabled = false;
      }
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      debug(`ICE connection state: ${peerConnection.iceConnectionState}`);
    };

    // Handle signaling state changes
    peerConnection.onsignalingstatechange = () => {
      debug(`Signaling state: ${peerConnection.signalingState}`);
    };

    // Read answer from incoming unidirectional stream
    debug("Waiting for SDP answer from server...");
    const incomingStream =
      await webTransport.incomingUnidirectionalStreams.getReader();
    debug("Got incoming stream reader");

    // Start handling incoming streams
    handleIncomingStreams(incomingStream);

    log("WebRTC connection established successfully");
  } catch (error) {
    debug(`Error during connection: ${error.message}`);
    debug(`Error stack: ${error.stack}`);
    log(`Error during connection: ${error.message}`);
    updateStatus("Connection Failed", "disconnected");
    connectBtn.disabled = false;
  }
}

// Function to send ICE candidate to server
async function sendIceCandidate(candidate) {
  try {
    const writer = (
      await webTransport.createUnidirectionalStream()
    ).getWriter();
    const encoder = new TextEncoder();

    const candidateMessage = {
      type: "ice-candidate",
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    };

    const candidateData = encoder.encode(JSON.stringify(candidateMessage));
    debug(`Sending ICE candidate, size: ${candidateData.length} bytes`);
    await writer.write(candidateData);
    await writer.close();
    debug("ICE candidate sent and stream closed");
  } catch (error) {
    debug(`Error sending ICE candidate: ${error.message}`);
  }
}

// Function to handle incoming streams (SDP answer and ICE candidates)
async function handleIncomingStreams(incomingStream) {
  try {
    while (true) {
      const { value: stream, done } = await incomingStream.read();
      if (done) break;

      debug("Received incoming stream");
      const reader = stream.getReader();
      const { value: response } = await reader.read();
      debug(`Received response data, size: ${response.length} bytes`);
      const decoder = new TextDecoder();
      const data = JSON.parse(decoder.decode(response));
      debug(`Parsed message: type=${data.type}`);

      if (data.type === "answer") {
        log("Received SDP answer from server");
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data)
        );
        debug("Remote description set");
        log("Remote description set");
      } else if (data.type === "ice-candidate") {
        debug(`Received ICE candidate: ${data.candidate}`);
        await peerConnection.addIceCandidate(
          new RTCIceCandidate({
            candidate: data.candidate,
            sdpMid: data.sdpMid,
            sdpMLineIndex: data.sdpMLineIndex,
          })
        );
        debug("ICE candidate added to peer connection");
      } else {
        debug(`Unknown message type: ${data.type}`);
      }
    }
  } catch (error) {
    debug(`Error handling incoming streams: ${error.message}`);
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

  log("Client initialized. Click Connect to start.");
}

// Export functions for global access
window.connect = connect;
window.disconnect = disconnect;
window.initializeClient = initializeClient;
