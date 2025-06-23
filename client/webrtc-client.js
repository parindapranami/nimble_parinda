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

// Function to force H.264 codec in SDP -
function forceH264(sdp) {
  console.log("🔧 Forcing H.264 codec in client-side SDP");
  const lines = sdp.split("\r\n");

  const h264PayloadTypes = new Set();
  const codecsToKeep = new Set();

  // Step 1: Find H.264 payload types
  for (const line of lines) {
    if (line.startsWith("a=rtpmap:") && line.includes("H264")) {
      const parts = line.split(" ");
      const pt = parts[0].split(":")[1];
      h264PayloadTypes.add(pt);
    }
  }

  if (h264PayloadTypes.size === 0) {
    console.warn("⚠️ No H.264 payload types found in SDP, returning original");
    return sdp;
  }

  h264PayloadTypes.forEach((pt) => codecsToKeep.add(pt));

  // Step 2: Find RTX payload types associated with H.264
  for (const line of lines) {
    if (line.startsWith("a=fmtp:") && line.includes("apt=")) {
      const parts = line.split(" ");
      const rtxPt = parts[0].split(":")[1];
      const aptMatch = line.match(/apt=(\d+)/);
      if (aptMatch && h264PayloadTypes.has(aptMatch[1])) {
        codecsToKeep.add(rtxPt);
      }
    }
  }

  console.log(
    `🎯 Codecs to keep (H.264 + RTX): ${[...codecsToKeep].join(", ")}`
  );

  // Step 3: Rebuild SDP
  const newLines = [];
  let inVideoSection = false;

  for (const line of lines) {
    if (line.startsWith("m=video")) {
      inVideoSection = true;
      const parts = line.trim().split(" ");
      const header = parts.slice(0, 3);
      const payloadTypes = parts.slice(3);

      const filteredPayloads = payloadTypes.filter((pt) =>
        codecsToKeep.has(pt)
      );
      if (filteredPayloads.length === 0) {
        console.warn(
          "⚠️ No matching H.264 payloads found for m=video, keeping original"
        );
        newLines.push(line);
        continue;
      }

      const newMLine = [...header, ...filteredPayloads].join(" ");
      newLines.push(newMLine);
      console.log(`✅ Rewrote m-line: ${newMLine}`);
    } else if (
      inVideoSection &&
      (line.startsWith("a=rtpmap:") ||
        line.startsWith("a=fmtp:") ||
        line.startsWith("a=rtcp-fb:"))
    ) {
      try {
        const pt = line.split(":")[1].split(" ")[0];
        if (codecsToKeep.has(pt)) {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    } else if (line.startsWith("m=")) {
      inVideoSection = false;
      newLines.push(line);
    } else {
      newLines.push(line);
    }
  }

  // Safety check
  const hasVideoMLine = newLines.some((l) => l.startsWith("m=video"));
  const hasH264 = newLines.some((l) => l.includes("H264"));
  if (!hasVideoMLine || !hasH264) {
    console.error(
      "❌ SDP rewrite failed, missing m=video or H264. Reverting to original SDP."
    );
    return sdp;
  }

  console.log("✅ SDP modification complete");
  return newLines.join("\r\n");
}

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

    log("Requirement 7: Forcing H.264 codec in client-side SDP");
    offer.sdp = forceH264(offer.sdp);

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

        // Requirement 7: Verify the active video codec
        // This is the correct way to check the active codec, not just the list of supported ones.
        const checkCodec = async () => {
          try {
            if (
              peerConnection &&
              typeof peerConnection.getStats === "function"
            ) {
              const stats = await peerConnection.getStats();
              let activeCodec;
              stats.forEach((report) => {
                if (report.type === "inbound-rtp" && report.kind === "video") {
                  const codecId = report.codecId;
                  if (codecId) {
                    const codecReport = stats.get(codecId);
                    if (codecReport) {
                      activeCodec = codecReport;
                    }
                  }
                }
              });

              if (activeCodec) {
                if (activeCodec.mimeType.toLowerCase() === "video/h264") {
                  log(
                    `Requirement 7: VERIFIED - Active codec is H.264. MimeType: ${activeCodec.mimeType}, ClockRate: ${activeCodec.clockRate}`
                  );
                } else {
                  log(
                    `Requirement 7: WARNING - Active codec is NOT H.264. Active codec: ${activeCodec.mimeType}`
                  );
                }
              } else {
                log(
                  "Requirement 7: Could not determine active codec from stats."
                );
              }
            }
          } catch (e) {
            log(`Could not verify codec using getStats(): ${e.message}`);
          }
        };
        // Run the check after a short delay to allow the connection to be fully established.
        setTimeout(checkCodec, 1000);

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
