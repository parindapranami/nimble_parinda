// WebRTC client for receiving video stream from server
// This connects to the server and displays the bouncing ball video

let webTransport = null;
let peerConnection = null;
let videoElement = null;
let statusDiv = null;
let connectBtn = null;
let disconnectBtn = null;
let logDiv = null;
let trackingCanvas = null;
let trackingCtx = null;

// WebRTC configuration with STUN servers
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// Flag to only show error feedback message once
let errorFeedbackLogged = false;

// Function to make sure we use H.264 codec
function forceH264(sdp) {
  console.log("Making sure H.264 codec is used");
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
    console.warn("No H.264 found in SDP, using original");
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

  console.log(`Keeping codecs: ${[...codecsToKeep].join(", ")}`);

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
        console.warn("No H.264 payloads found, keeping original");
        newLines.push(line);
        continue;
      }

      const newMLine = [...header, ...filteredPayloads].join(" ");
      newLines.push(newMLine);
      console.log(`New m-line: ${newMLine}`);
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

  // Check if we still have video and H.264
  const hasVideoMLine = newLines.some((l) => l.startsWith("m=video"));
  const hasH264 = newLines.some((l) => l.includes("H264"));
  if (!hasVideoMLine || !hasH264) {
    console.error("SDP rewrite failed, using original");
    return sdp;
  }

  console.log("SDP modification done");
  return newLines.join("\r\n");
}

// Add message to log with timestamp
function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logDiv.innerHTML += `[${timestamp}] ${message}<br>`;
  logDiv.scrollTop = logDiv.scrollHeight;
  console.log(message);
}

// Update the status display
function updateStatus(status, className) {
  statusDiv.textContent = `Status: ${status}`;
  statusDiv.className = `status ${className}`;
}

// Main connection function
async function connect() {
  try {
    updateStatus("Connecting...", "connecting");
    connectBtn.disabled = true;

    log("Starting connection to server");
    log("Setting up WebTransport connection");

    // Connect to WebTransport
    webTransport = new WebTransport("https://localhost:4433/connection");
    await webTransport.ready;
    log("WebTransport connected successfully");

    // Create WebRTC peer connection
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Set up ICE candidate event handler before creating offer
    await new Promise((resolve) => {
      let resolved = false;
      const handler = (event) => {
        if (!event.candidate && !resolved) {
          peerConnection.removeEventListener("icecandidate", handler);
          resolved = true;
          resolve();
        }
      };
      peerConnection.addEventListener("icecandidate", handler);

      // Now safe to create offer
      (async () => {
        // Create offer for video
        const offer = await peerConnection.createOffer({
          offerToReceiveVideo: true,
          offerToReceiveAudio: false,
        });

        // Force H.264 codec
        offer.sdp = forceH264(offer.sdp);
        await peerConnection.setLocalDescription(offer);
      })();
    });

    const finalOffer = peerConnection.localDescription;

    // Send offer to server
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
    log("SDP offer sent to server");

    // Handle incoming video track
    peerConnection.ontrack = (event) => {
      if (event.track.kind === "video") {
        log("Video track received from server");

        // Check what codec is actually being used
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
                  log(`Codec check: Using H.264 (${activeCodec.mimeType})`);
                } else {
                  log(`Codec check: Using ${activeCodec.mimeType} (not H.264)`);
                  showVideoError(
                    "Warning: Non-H.264 codec detected. Video may not display correctly."
                  );
                }
              } else {
                log("Could not check codec from stats");
              }
            }
          } catch (e) {
            log(`Codec check failed: ${e.message}`);
          }
        };
        setTimeout(checkCodec, 1000);

        // Set up video element
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.muted = true;
        videoElement.controls = false;

        log("Setting up video element with autoplay and muted");
        videoElement.srcObject = event.streams[0];
        log("Video stream connected to video element");

        // Add a small delay to ensure srcObject is fully processed
        setTimeout(() => {}, 100);

        // Track video state
        let videoPlayAttempts = 0;
        const maxPlayAttempts = 3;

        videoElement.onloadedmetadata = () => {
          // Removed verbose logging
        };

        videoElement.oncanplay = () => {
          log("Video can start playing - attempting to play");
          // Only attempt play if we haven't already started and video is ready
          if (
            videoElement.paused &&
            videoPlayAttempts === 0 &&
            videoElement.readyState >= 2
          ) {
            videoPlayAttempts++;
            videoElement
              .play()
              .then(() => {
                log("Video play successful");
              })
              .catch((e) => {
                log(`Auto-play failed on canplay: ${e.message}`);
                // Try again after a short delay
                setTimeout(() => {
                  if (videoPlayAttempts < maxPlayAttempts) {
                    videoPlayAttempts++;
                    log(`Retry attempt ${videoPlayAttempts} to play video`);
                    videoElement
                      .play()
                      .then(() => log("Video play successful on retry"))
                      .catch((retryError) =>
                        log(`Video play failed on retry: ${retryError.message}`)
                      );
                  } else {
                    log("Max video play attempts reached");
                    showVideoError(
                      "Video playback failed. Please try refreshing the page or check browser autoplay settings."
                    );
                  }
                }, 500);
              });
          } else {
            log(
              `Skipping play attempt - paused: ${videoElement.paused}, attempts: ${videoPlayAttempts}, readyState: ${videoElement.readyState}`
            );
          }
        };

        videoElement.onerror = (e) => {
          log(`Video error: ${e.message || "Unknown video error"}`);
          showVideoError(
            "Video playback error occurred. Please check your connection and try again."
          );
        };

        videoElement.onwaiting = () => {
          log("Video is waiting for data");
        };

        videoElement.oncanplaythrough = () => {
          // Removed verbose logging
        };

        videoElement.onplaying = () => {
          log("Video is now playing - starting ball tracking");
          hideVideoError(); // Clear any previous error messages

          setupBallTracking();

          const canvas = document.getElementById("hiddenCanvas");
          const ctx = canvas.getContext("2d");

          // Add a small delay to ensure first frame is ready
          setTimeout(() => {
            log("Starting ball tracking after frame delay");

            // Loop to track ball position
            function trackLoop() {
              // Check if video is still playing and has content
              if (
                videoElement.paused ||
                videoElement.ended ||
                videoElement.readyState < 2
              ) {
                log("Video not ready for tracking, stopping loop");
                return;
              }

              try {
                const pos = estimateBallCenterFromVideo(
                  videoElement,
                  canvas,
                  ctx
                );
                if (pos) {
                  // Send ball coordinates to server
                  if (webTransport) {
                    // Check if WebTransport is ready by attempting to create a stream
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
                            console.error(`Error sending coordinates: ${err}`)
                          );
                      })
                      .catch((err) => {
                        if (
                          err.message.includes(
                            "WebTransport session is not ready"
                          )
                        ) {
                          log(
                            "WebTransport not ready, skipping coordinate send"
                          );
                        } else {
                          console.error(`Error creating stream: ${err}`);
                        }
                      });
                  } else {
                    log("WebTransport not available, skipping coordinate send");
                  }
                }
              } catch (error) {
                log(`Error in ball tracking: ${error.message}`);
                // Stop the loop if there's an error
                return;
              }

              requestAnimationFrame(trackLoop);
            }

            requestAnimationFrame(trackLoop);
          }, 200); // 200ms delay to ensure first frame is ready
        };

        videoElement.onpause = () => {
          log("Video paused");
        };

        videoElement.onended = () => {
          log("Video ended");
        };

        // Try to play video after a short delay as fallback
        setTimeout(() => {
          if (videoElement.paused) {
            log("Attempting fallback video play");
            videoElement
              .play()
              .then(() => {
                log("Fallback video play successful");
              })
              .catch((error) => {
                log(`Fallback video play failed: ${error.message}`);
                if (videoPlayAttempts === 0) {
                  showVideoError(
                    "Video failed to start automatically. Please check browser autoplay settings."
                  );
                }
              });
          }
        }, 1000);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      log(
        `WebRTC connection state changed to: ${peerConnection.connectionState}`
      );

      if (peerConnection.connectionState === "connected") {
        updateStatus("Connected", "connected");
        disconnectBtn.disabled = false;
        log("WebRTC connection successful");
        log("Ready to receive video");
        hideVideoError(); // Clear any connection errors
      } else if (
        peerConnection.connectionState === "failed" ||
        peerConnection.connectionState === "closed"
      ) {
        updateStatus("Connection Failed", "disconnected");
        connectBtn.disabled = false;
        disconnectBtn.disabled = true;
        log(`WebRTC connection ${peerConnection.connectionState}`);

        if (peerConnection.connectionState === "failed") {
          showVideoError(
            "WebRTC connection failed. Please check your network and try again."
          );
        }
      } else if (peerConnection.connectionState === "connecting") {
        log("WebRTC connecting...");
        updateStatus("Connecting WebRTC...", "connecting");
      } else if (peerConnection.connectionState === "disconnected") {
        log("WebRTC disconnected");
        updateStatus("Disconnected", "disconnected");
        showVideoError("WebRTC connection lost. Please reconnect.");
      }
    };

    // Handle ICE connection state
    peerConnection.oniceconnectionstatechange = () => {
      log(
        `ICE connection state changed to: ${peerConnection.iceConnectionState}`
      );

      if (peerConnection.iceConnectionState === "connected") {
        log("ICE connection established");
      } else if (
        peerConnection.iceConnectionState === "failed" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        log(`ICE connection ${peerConnection.iceConnectionState}`);

        if (peerConnection.iceConnectionState === "failed") {
          showVideoError(
            "ICE connection failed. This may be due to network restrictions or firewall settings."
          );
        }
      } else if (peerConnection.iceConnectionState === "checking") {
        log("ICE checking...");
      } else if (peerConnection.iceConnectionState === "disconnected") {
        log("ICE disconnected");
        showVideoError("ICE connection lost. Trying to reconnect...");
      }
    };

    // Read server responses
    const incomingStream =
      await webTransport.incomingUnidirectionalStreams.getReader();

    handleIncomingStreams(incomingStream);

    log("Connection setup complete");
  } catch (error) {
    log(`Connection error: ${error.message}`);

    // Provide more specific error messages based on error type
    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("ERR_CONNECTION_REFUSED")
    ) {
      showVideoError(
        "Cannot connect to server. Please ensure the server is running on localhost:4433"
      );
    } else if (
      error.message.includes("ERR_CERT_AUTHORITY_INVALID") ||
      error.message.includes("certificate")
    ) {
      showVideoError(
        "Certificate error. Please accept the self-signed certificate or check your browser settings."
      );
    } else if (error.message.includes("WebTransport")) {
      showVideoError(
        "WebTransport not supported or failed. Please use a modern browser with WebTransport support."
      );
    } else if (
      error.message.includes("WebRTC") ||
      error.message.includes("RTCPeerConnection")
    ) {
      showVideoError(
        "WebRTC error. Please check your browser supports WebRTC and try again."
      );
    } else {
      showVideoError(`Connection failed: ${error.message}`);
    }

    updateStatus("Connection Failed", "disconnected");
    connectBtn.disabled = false;
  }
}

// Show error messages from server
function displayError(error, data) {
  console.log(`Server error: ${error}`);
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

// Show video-specific error messages
function showVideoError(message) {
  let videoErrorDiv = document.getElementById("videoErrorDiv");
  if (!videoErrorDiv) {
    videoErrorDiv = document.createElement("div");
    videoErrorDiv.id = "videoErrorDiv";
    videoErrorDiv.style.margin = "10px 0";
    videoErrorDiv.style.padding = "10px";
    videoErrorDiv.style.backgroundColor = "#ffebee";
    videoErrorDiv.style.border = "1px solid #f44336";
    videoErrorDiv.style.borderRadius = "4px";
    videoErrorDiv.style.color = "#c62828";
    videoErrorDiv.style.fontWeight = "bold";
    videoErrorDiv.style.textAlign = "center";
    document
      .querySelector(".video-container")
      .insertBefore(videoErrorDiv, document.querySelector("video"));
  }
  videoErrorDiv.textContent = message;
  videoErrorDiv.style.display = "block";
}

// Hide video error messages
function hideVideoError() {
  const videoErrorDiv = document.getElementById("videoErrorDiv");
  if (videoErrorDiv) {
    videoErrorDiv.style.display = "none";
  }
}

// Handle messages from server
async function handleIncomingStreams(incomingStream) {
  try {
    while (true) {
      const { value: stream, done } = await incomingStream.read();
      if (done) {
        log("Server stream ended");
        break;
      }

      const reader = stream.getReader();
      const { value: response } = await reader.read();
      const decoder = new TextDecoder();
      const data = JSON.parse(decoder.decode(response));

      if (data.type === "answer") {
        log("Got SDP answer from server");
        if (peerConnection) {
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(data)
          );
          log("Remote description set");
        } else {
          log("PeerConnection is closed/null, skipping setRemoteDescription");
        }
      } else if (data.type === "error") {
        if (!errorFeedbackLogged) {
          log("Server will show ball detection errors below video");
          errorFeedbackLogged = true;
        }
        displayError(data.error, data);
      } else {
        log(`Unknown message: ${data.type}`);
      }
    }
  } catch (error) {
    log(`Error reading server messages: ${error.message}`);

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

// Disconnect from server
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
    log(`Disconnect error: ${error.message}`);
  }
}

// Initialize the client when page loads
function initializeClient() {
  videoElement = document.getElementById("videoElement");
  statusDiv = document.getElementById("status");
  connectBtn = document.getElementById("connectBtn");
  disconnectBtn = document.getElementById("disconnectBtn");
  logDiv = document.getElementById("log");

  window.canvas = document.getElementById("hiddenCanvas");
  window.ctx = window.canvas.getContext("2d");

  // Clean up when page closes
  window.addEventListener("beforeunload", () => {
    disconnect();
  });

  log("---Nimble Programming Challenge - 2025---");
  log("WebRTC client ready");
  log("Click Connect to start");
}

// Clear the log display
function clearLog() {
  if (logDiv) {
    logDiv.innerHTML = "";
    log("Log cleared");
  }
}

// Set up ball tracking canvas
function setupBallTracking() {
  trackingCanvas = document.createElement("canvas");
  trackingCanvas.width = 640;
  trackingCanvas.height = 480;
  trackingCanvas.style.display = "none";
  document.body.appendChild(trackingCanvas);
  trackingCtx = trackingCanvas.getContext("2d");
}

// Find the green ball in the video frame
function estimateBallCenterFromVideo(videoElement, canvas, ctx) {
  try {
    // Check if video is ready to provide frames
    if (
      videoElement.readyState < 2 ||
      videoElement.paused ||
      videoElement.ended
    ) {
      return null;
    }

    // Check if video has actual dimensions
    if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
      return null;
    }

    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;

    // Check if frame has any non-black pixels (basic validation)
    let hasContent = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) {
        hasContent = true;
        break;
      }
    }

    if (!hasContent) {
      return null; // Frame is blank/black
    }

    let totalX = 0;
    let totalY = 0;
    let count = 0;

    // Look for green pixels (the ball)
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

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
  } catch (error) {
    console.error("Error in ball detection:", error);
    return null;
  }
}

// Make functions available to HTML
window.connect = connect;
window.disconnect = disconnect;
window.initializeClient = initializeClient;
window.clearLog = clearLog;
