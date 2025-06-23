let webTransport = null;
let peerConnection = null;
let videoElement = null;
let statusDiv = null;
let connectBtn = null;
let disconnectBtn = null;
let logDiv = null;
let trackingCanvas = null;
let trackingCtx = null;

// WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// Add a flag to only log the error feedback info once
let errorFeedbackLogged = false;

// Function to force H.264 codec in SDP -
function forceH264(sdp) {
  console.log("🔧 Forcing H.264 codec in client-side SDP");
  const lines = sdp.split("\r\n");

  const h264PayloadTypes = new Set();
  const codecsToKeep = new Set();

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

  console.log(`Codecs to keep (H.264 + RTX): ${[...codecsToKeep].join(", ")}`);

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
      console.log(`✅ Rewritten m-line: ${newMLine}`);
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

  const hasVideoMLine = newLines.some((l) => l.startsWith("m=video"));
  const hasH264 = newLines.some((l) => l.includes("H264"));
  if (!hasVideoMLine || !hasH264) {
    console.error(
      "SDP rewrite failed, missing m=video or H264. Reverting to original SDP."
    );
    return sdp;
  }

  console.log("SDP modification complete");
  return newLines.join("\r\n");
}

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

    log("Simple web app client initialized");
    log("Client ready to connect to server");
    log("Click Connect to start WebRTC + WebTransport connection");

    webTransport = new WebTransport("https://localhost:4433/connection");

    await webTransport.ready;
    log("WebTransport connection established successfully");

    peerConnection = new RTCPeerConnection(rtcConfig);

    const offer = await peerConnection.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: false,
    });

    offer.sdp = forceH264(offer.sdp);

    await peerConnection.setLocalDescription(offer);

    await new Promise((resolve) => {
      if (peerConnection.iceGatheringState === "complete") {
        resolve();
      } else {
        peerConnection.onicecandidate = (event) => {
          if (!event.candidate) {
            resolve();
          }
        };
      }
    });

    const finalOffer = peerConnection.localDescription;

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
    log("SDP offer sent to server via WebTransport");

    peerConnection.ontrack = (event) => {
      if (event.track.kind === "video") {
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
                    `VERIFIED - Active codec is H.264. MimeType: ${activeCodec.mimeType}, ClockRate: ${activeCodec.clockRate}`
                  );
                } else {
                  log(
                    `WARNING - Active codec is NOT H.264. Active codec: ${activeCodec.mimeType}`
                  );
                }
              } else {
                log("Could not determine active codec from stats.");
              }
            }
          } catch (e) {
            log(`Could not verify codec using getStats(): ${e.message}`);
          }
        };
        setTimeout(checkCodec, 1000);

        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true;
        videoElement.controls = false;

        videoElement.srcObject = event.streams[0];
        log("Video stream attached to browser video element");

        videoElement.onloadedmetadata = () => {
          videoElement.play().catch((e) => log(`Auto-play failed: ${e}`));
        };

        videoElement.onplay = () => {};

        videoElement.onerror = (e) => {
          log(`Video error: ${e}`);
        };

        videoElement.oncanplay = () => {};

        videoElement.onloadeddata = () => {};

        videoElement.onwaiting = () => {};

        videoElement.onplaying = () => {
          log(
            "[onplaying] Video is playing in browser, starting coordinate sending loop"
          );

          setupBallTracking();

          const canvas = document.getElementById("hiddenCanvas");
          const ctx = canvas.getContext("2d");

          function trackLoop() {
            const pos = estimateBallCenterFromVideo(videoElement, canvas, ctx);
            if (pos) {
              // Ball center estimated, send to server
              if (webTransport) {
                webTransport
                  .createUnidirectionalStream()
                  .then((stream) => {
                    const writer = stream.getWriter();
                    const message = JSON.stringify({
                      type: "coords",
                      x: pos.x,
                      y: pos.y,
                    });

                    writer
                      .write(new TextEncoder().encode(message))
                      .then(() => writer.close())
                      .catch((err) =>
                        console.error(
                          `[BallCoord] Error writing coordinates to server: ${err}`
                        )
                      );
                  })
                  .catch((err) =>
                    console.error(
                      `[BallCoord] Error creating unidirectional stream: ${err}`
                    )
                  );
              }
            }
            requestAnimationFrame(trackLoop);
          }

          requestAnimationFrame(trackLoop);
        };

        setTimeout(() => {
          videoElement
            .play()
            .then(() => {
              log("Video play() succeeded in browser");
            })
            .catch((error) => {
              log(`Video play() failed: ${error}`);
            });
        }, 100);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") {
        updateStatus("Connected", "connected");
        disconnectBtn.disabled = false;
        log("WebRTC connection established successfully");
        log("WebTransport connection active");
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

    peerConnection.onsignalingstatechange = () => {};

    // Read answer from incoming unidirectional stream
    const incomingStream =
      await webTransport.incomingUnidirectionalStreams.getReader();

    handleIncomingStreams(incomingStream);

    log("WebRTC connection established successfully");
  } catch (error) {
    log(`Error during connection: ${error.message}`);
    updateStatus("Connection Failed", "disconnected");
    connectBtn.disabled = false;
  }
}

function displayError(error, data) {
  console.log(`[ERROR FEEDBACK] Error from server: ${error}`);
  let errorDiv = document.getElementById("errorDiv");
  if (!errorDiv) {
    errorDiv = document.createElement("div");
    errorDiv.id = "errorDiv";
    errorDiv.style.margin = "10px 0";
    errorDiv.style.fontWeight = "bold";
    errorDiv.style.color = "#d32f2f";
    document
      .querySelector(".container")
      .insertBefore(errorDiv, document.querySelector(".log-container"));
  }
  errorDiv.textContent = `Ball detection error: ${error}`;
  if (
    data &&
    data.client_x !== undefined &&
    data.client_y !== undefined &&
    data.true_x !== undefined &&
    data.true_y !== undefined
  ) {
    errorDiv.textContent += ` | Your: (${data.client_x}, ${data.client_y}) | True: (${data.true_x}, ${data.true_y})`;
  }
}

async function handleIncomingStreams(incomingStream) {
  try {
    while (true) {
      const { value: stream, done } = await incomingStream.read();
      if (done) {
        log("Incoming stream reader done");
        break;
      }

      const reader = stream.getReader();
      const { value: response } = await reader.read();
      const decoder = new TextDecoder();
      const data = JSON.parse(decoder.decode(response));

      if (data.type === "answer") {
        log("Received SDP answer from server");
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(data)
        );
        log("Remote description set from server response");
      } else if (data.type === "error") {
        if (!errorFeedbackLogged) {
          log(
            "Ball error feedback is now being calculated by the server and displayed below the video."
          );
          errorFeedbackLogged = true;
        }
        displayError(data.error, data);
      } else {
        log(`Unknown message type: ${data.type}`);
      }
    }
  } catch (error) {
    log(`Error handling incoming streams: ${error.message}`);

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

function initializeClient() {
  videoElement = document.getElementById("videoElement");
  statusDiv = document.getElementById("status");
  connectBtn = document.getElementById("connectBtn");
  disconnectBtn = document.getElementById("disconnectBtn");
  logDiv = document.getElementById("log");

  window.canvas = document.getElementById("hiddenCanvas");
  window.ctx = window.canvas.getContext("2d");

  window.addEventListener("beforeunload", () => {
    disconnect();
  });

  log("---Nimble Programming Challenge - 2025---");
  log("Simple web app client initialized");
  log("Click Connect to start WebRTC + WebTransport connection");
}

function clearLog() {
  if (logDiv) {
    logDiv.innerHTML = "";
    log("Log cleared");
  }
}

window.connect = connect;
window.disconnect = disconnect;
window.initializeClient = initializeClient;
window.clearLog = clearLog;

function setupBallTracking() {
  // Create a hidden canvas for frame extraction
  trackingCanvas = document.createElement("canvas");
  trackingCanvas.width = 640;
  trackingCanvas.height = 480;
  trackingCanvas.style.display = "none";
  document.body.appendChild(trackingCanvas);
  trackingCtx = trackingCanvas.getContext("2d");
}

// Estimate ball center by scanning for green ball
function estimateBallCenterFromVideo(videoElement, canvas, ctx) {
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = frame.data;

  let totalX = 0;
  let totalY = 0;
  let count = 0;

  // Thresholds for detecting "green"
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Simple green ball detection
      if (g > 150 && g > r + 60 && g > b + 60) {
        totalX += x;
        totalY += y;
        count++;
      }
    }
  }

  if (count === 0) return null;

  const cx = Math.round(totalX / count);
  const cy = Math.round(totalY / count);

  return { x: cx, y: cy };
}
