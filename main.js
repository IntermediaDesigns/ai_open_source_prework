(function () {
  const canvas = document.getElementById("map-canvas");
  const ctx = canvas.getContext("2d");

  // Device pixel ratio handling for crisp rendering on HiDPI without logical scaling.
  const getPixelRatio = () =>
    Math.max(1, Math.floor(window.devicePixelRatio || 1));

  // Config
  const USE_DETERMINISTIC_SPAWN = true; // Keep initial camera consistent across reloads

  // World image (2048x2048 by default per README)
  const worldImage = new Image();
  worldImage.src = "world.jpg";
  worldImage.decoding = "async";

  // Networking
  const WS_URL = "wss://codepath-mmorg.onrender.com";
  let ws;

  // Input state
  const keysPressed = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  let movementLoopId = null;
  let lastMoveTime = 0;
  const MOVE_THROTTLE_MS = 100; // Only send move commands every 100ms
  let canSendMoveCommands = false; // Only send moves after we have server position

  // Game state
  const state = {
    world: {
      image: worldImage,
      width: 0,
      height: 0,
      ready: false,
    },
    me: {
      id: null,
      username: "Tim",
      x: 1024, // Default to world center to avoid top-left flash
      y: 1024,
      facing: "south",
      animationFrame: 0,
      avatarName: null,
      ready: false,
      hasServerPosition: false, // Track if we have a confirmed position from server
    },
    avatars: {
      // avatars[name] = { frames: { north: Image[], south: Image[], east: Image[], west: Image[] } }
      byName: {},
    },
    otherPlayers: {
      // otherPlayers[id] = { id, x, y, facing, animationFrame, username, avatarName, targetX, targetY, lastUpdate }
      byId: {},
    },
    viewport: {
      width: 0,
      height: 0,
      cameraX: 0,
      cameraY: 0,
    },
  };

  // Utility
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function flipImageHorizontally(image) {
    const off = document.createElement("canvas");
    off.width = image.naturalWidth || image.width;
    off.height = image.naturalHeight || image.height;
    const octx = off.getContext("2d");
    octx.translate(off.width, 0);
    octx.scale(-1, 1);
    octx.drawImage(image, 0, 0);
    const flipped = new Image();
    flipped.decoding = "async";
    flipped.src = off.toDataURL();
    return flipped;
  }

  function resizeCanvas() {
    const ratio = getPixelRatio();

    // Set the canvas CSS size to fill the viewport
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";

    // Set the actual canvas size in device pixels for crispness
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);

    // Scale the context so 1 unit in canvas equals 1 CSS pixel
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    state.viewport.width = window.innerWidth;
    state.viewport.height = window.innerHeight;

    // Recompute camera on resize
    updateCamera();
  }

  function updateCamera() {
    if (
      !state.world.ready ||
      state.world.width === 0 ||
      state.world.height === 0 ||
      !state.me.hasServerPosition
    )
      return;

    const vw = state.viewport.width;
    const vh = state.viewport.height;
    const ww = state.world.width;
    const wh = state.world.height;

    // Desired camera centers on me
    let desiredX = state.me.x - Math.floor(vw / 2);
    let desiredY = state.me.y - Math.floor(vh / 2);

    // Clamp so we don't show past the edges
    const maxX = Math.max(0, ww - vw);
    const maxY = Math.max(0, wh - vh);

    state.viewport.cameraX = clamp(desiredX, 0, maxX);
    state.viewport.cameraY = clamp(desiredY, 0, maxY);
  }

  async function cacheAvatarFrames(avatar) {
    if (!avatar || !avatar.frames) return;

    const dirs = ["north", "south", "east"];
    const cached = { north: [], south: [], east: [], west: [] };

    for (const dir of dirs) {
      const sources = avatar.frames[dir] || [];
      for (let i = 0; i < sources.length; i++) {
        // Load each frame image
        const img = await loadImage(sources[i]);
        cached[dir][i] = img;
      }
    }

    // Precompute west frames by flipping east frames
    const eastFrames = cached.east || [];
    for (let i = 0; i < eastFrames.length; i++) {
      cached.west[i] = flipImageHorizontally(eastFrames[i]);
    }

    state.avatars.byName[avatar.name] = { frames: cached };
  }

  async function cacheMyAvatarFrames(avatarsMap, myAvatarName) {
    const avatar = avatarsMap[myAvatarName];
    if (!avatar) return;

    // Use the generic cache function
    await cacheAvatarFrames(avatar);
  }

  function drawWorld() {
    if (!state.world.ready) return;

    const sx = state.viewport.cameraX;
    const sy = state.viewport.cameraY;
    const sw = state.viewport.width;
    const sh = state.viewport.height;

    const dx = 0;
    const dy = 0;
    const dw = state.viewport.width;
    const dh = state.viewport.height;

    // Source rect must be within image bounds
    ctx.drawImage(state.world.image, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function getMyCurrentFrame() {
    const avatarName = state.me.avatarName;
    const avatar = state.avatars.byName[avatarName];
    if (!avatar) return null;

    let dir = state.me.facing || "south";
    if (
      dir !== "north" &&
      dir !== "south" &&
      dir !== "east" &&
      dir !== "west"
    ) {
      dir = "south";
    }
    const frames = avatar.frames[dir] || [];
    const idx = clamp(
      state.me.animationFrame | 0,
      0,
      Math.max(0, frames.length - 1)
    );
    return frames[idx] || null;
  }

  function drawNameLabel(text, xCenter, topY, paddingY = 4) {
    ctx.font = "14px sans-serif";
    ctx.textBaseline = "top";
    const metrics = ctx.measureText(text);
    const textWidth = Math.ceil(metrics.width);
    const textHeight = 16; // approx height
    const padX = 6;

    const boxWidth = textWidth + padX * 2;
    const boxHeight = textHeight + paddingY * 2;

    const boxX = Math.round(xCenter - boxWidth / 2);
    const boxY = Math.round(topY - boxHeight - 4);

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

    // Text
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, boxX + padX, boxY + paddingY);
  }

  function getPlayerCurrentFrame(player) {
    const avatar = state.avatars.byName[player.avatarName];
    if (!avatar) return null;

    let dir = player.facing || "south";
    if (
      dir !== "north" &&
      dir !== "south" &&
      dir !== "east" &&
      dir !== "west"
    ) {
      dir = "south";
    }
    const frames = avatar.frames[dir] || [];
    const idx = clamp(
      player.animationFrame | 0,
      0,
      Math.max(0, frames.length - 1)
    );
    return frames[idx] || null;
  }

  function drawPlayer(player) {
    const frame = getPlayerCurrentFrame(player);
    if (!frame || !frame.complete) return;

    const frameW = frame.naturalWidth || frame.width;
    const frameH = frame.naturalHeight || frame.height;

    // Screen position relative to camera
    const screenX = player.x - state.viewport.cameraX;
    const screenY = player.y - state.viewport.cameraY;

    // Only draw if player is visible on screen
    if (
      screenX < -frameW ||
      screenX > state.viewport.width + frameW ||
      screenY < -frameH ||
      screenY > state.viewport.height + frameH
    ) {
      return; // Player is off-screen
    }

    // Anchor avatar so feet are at (player.x, player.y)
    const dx = Math.round(screenX - frameW / 2);
    const dy = Math.round(screenY - frameH);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, dx, dy);

    // Name label above head
    drawNameLabel(player.username, Math.round(screenX), dy);
  }

  function drawMe() {
    if (!state.me.ready) return;

    const frame = getMyCurrentFrame();
    if (!frame || !frame.complete) return;

    const frameW = frame.naturalWidth || frame.width;
    const frameH = frame.naturalHeight || frame.height;

    // Screen position relative to camera
    const screenX = state.me.x - state.viewport.cameraX;
    const screenY = state.me.y - state.viewport.cameraY;

    // Anchor avatar so feet are at (me.x, me.y)
    const dx = Math.round(screenX - frameW / 2);
    const dy = Math.round(screenY - frameH);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, dx, dy);

    // Name label above head
    drawNameLabel(state.me.username, Math.round(screenX), dy);
  }

  function updatePlayerInterpolation() {
    const now = Date.now();
    const interpolationSpeed = 0.1; // How fast to interpolate (0-1)

    for (const player of Object.values(state.otherPlayers.byId)) {
      if (player.targetX !== undefined && player.targetY !== undefined) {
        // Smooth interpolation towards target position
        const dx = player.targetX - player.x;
        const dy = player.targetY - player.y;

        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          player.x += dx * interpolationSpeed;
          player.y += dy * interpolationSpeed;
        } else {
          // Snap to target if very close
          player.x = player.targetX;
          player.y = player.targetY;
        }
      }
    }
  }

  function drawOtherPlayers() {
    for (const player of Object.values(state.otherPlayers.byId)) {
      drawPlayer(player);
    }
  }

  function render() {
    // Clear viewport
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!state.world.ready) return;

    // Update smooth interpolation for other players
    updatePlayerInterpolation();

    drawWorld();
    drawOtherPlayers(); // Draw other players first (behind me)
    drawMe(); // Draw me on top

    // Update minimap to show current positions
    updateMinimap();
  }

  function startRenderLoop() {
    function loop() {
      render();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  function setupKeyboardInput() {
    const keyMap = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      KeyW: "up",
      KeyS: "down",
      KeyA: "left",
      KeyD: "right",
    };

    function handleKeyDown(event) {
      const direction = keyMap[event.key];
      if (direction && !keysPressed[direction]) {
        keysPressed[direction] = true;
        event.preventDefault();
      }
    }

    function handleKeyUp(event) {
      const direction = keyMap[event.key];
      if (direction) {
        keysPressed[direction] = false;
        event.preventDefault();
      }
    }

    // Add event listeners to document to ensure we capture keys even when canvas doesn't have focus
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    // Also add to canvas for when it has focus
    canvas.addEventListener("keydown", handleKeyDown);
    canvas.addEventListener("keyup", handleKeyUp);

    // Make canvas focusable so it can receive key events
    canvas.setAttribute("tabindex", "0");

    // Add click-to-move functionality
    canvas.addEventListener("click", (event) => {
      if (!canSendMoveCommands || !ws || ws.readyState !== WebSocket.OPEN)
        return;

      const rect = canvas.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;

      // Convert screen coordinates to world coordinates
      const worldX = clickX + state.viewport.cameraX;
      const worldY = clickY + state.viewport.cameraY;

      // Send click-to-move command
      const moveMsg = {
        action: "move",
        x: Math.round(worldX),
        y: Math.round(worldY),
      };
      ws.send(JSON.stringify(moveMsg));
    });
  }

  function startMovementLoop() {
    if (movementLoopId) return; // Already running

    function movementLoop() {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        movementLoopId = setTimeout(movementLoop, 100); // Retry in 100ms
        return;
      }

      const now = Date.now();
      let hasActiveKeys = false;
      const activeDirections = [];

      // Check which keys are pressed
      for (const [direction, isPressed] of Object.entries(keysPressed)) {
        if (isPressed) {
          hasActiveKeys = true;
          activeDirections.push(direction);
        }
      }

      // Only send move commands if we have permission and enough time has passed
      if (
        hasActiveKeys &&
        canSendMoveCommands &&
        now - lastMoveTime >= MOVE_THROTTLE_MS
      ) {
        // Send one move command per active direction
        for (const direction of activeDirections) {
          const moveMsg = { action: "move", direction };
          ws.send(JSON.stringify(moveMsg));
        }
        lastMoveTime = now;
      } else if (!hasActiveKeys && canSendMoveCommands) {
        // Send stop command when no keys are pressed
        const stopMsg = { action: "stop" };
        ws.send(JSON.stringify(stopMsg));
      }

      // Continue the loop
      movementLoopId = setTimeout(movementLoop, 50); // ~20fps - less aggressive
    }

    movementLoop();
  }

  function stopMovementLoop() {
    if (movementLoopId) {
      clearTimeout(movementLoopId);
      movementLoopId = null;
    }
  }

  function updateUI() {
    // Update player count
    const totalPlayers = Object.keys(state.otherPlayers.byId).length + 1; // +1 for me
    const playerCountEl = document.getElementById("player-count");
    if (playerCountEl) {
      playerCountEl.textContent = `Players: ${totalPlayers}`;
    }

    // Update connection status
    const connectionStatusEl = document.getElementById("connection-status");
    if (connectionStatusEl) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        connectionStatusEl.textContent = "Connected";
        connectionStatusEl.className = "connected";
      } else {
        connectionStatusEl.textContent = "Disconnected";
        connectionStatusEl.className = "disconnected";
      }
    }

    // Update mini-map
    updateMinimap();
  }

  function updateMinimap() {
    const minimapCanvas = document.getElementById("minimap");
    if (!minimapCanvas || !state.world.ready) return;

    const minimapCtx = minimapCanvas.getContext("2d");
    const minimapSize = 200;
    const scale = minimapSize / Math.max(state.world.width, state.world.height);

    // Clear minimap
    minimapCtx.clearRect(0, 0, minimapSize, minimapSize);

    // Draw world background (simplified)
    minimapCtx.fillStyle = "#2a2a2a";
    minimapCtx.fillRect(0, 0, minimapSize, minimapSize);

    // Draw viewport rectangle
    const viewportX = state.viewport.cameraX * scale;
    const viewportY = state.viewport.cameraY * scale;
    const viewportW = state.viewport.width * scale;
    const viewportH = state.viewport.height * scale;

    minimapCtx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(viewportX, viewportY, viewportW, viewportH);

    // Draw my position
    const myX = state.me.x * scale;
    const myY = state.me.y * scale;
    minimapCtx.fillStyle = "#00ff00";
    minimapCtx.beginPath();
    minimapCtx.arc(myX, myY, 3, 0, Math.PI * 2);
    minimapCtx.fill();

    // Draw other players
    for (const player of Object.values(state.otherPlayers.byId)) {
      const playerX = player.x * scale;
      const playerY = player.y * scale;
      minimapCtx.fillStyle = "#ff0000";
      minimapCtx.beginPath();
      minimapCtx.arc(playerX, playerY, 2, 0, Math.PI * 2);
      minimapCtx.fill();
    }
  }

  function setupChat() {
    const chatInput = document.getElementById("chat-input");
    const chatMessages = document.getElementById("chat-messages");

    if (!chatInput || !chatMessages) return;

    // Add welcome message
    addChatMessage(
      "system",
      "Welcome to the MMO! Type messages to chat with other players."
    );

    // Handle chat input
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const message = chatInput.value.trim();
        if (message) {
          // Display message locally immediately
          addChatMessage("player", message, state.me.username);

          // Send chat message to server if connected
          if (ws && ws.readyState === WebSocket.OPEN) {
            const chatMsg = { action: "chat", message: message };
            ws.send(JSON.stringify(chatMsg));
          }
          chatInput.value = "";
        }
      }
    });
  }

  function addChatMessage(type, content, username = null) {
    const chatMessages = document.getElementById("chat-messages");
    if (!chatMessages) return;

    const messageDiv = document.createElement("div");
    messageDiv.className = "chat-message";

    if (type === "system") {
      messageDiv.innerHTML = `<span class="system">${content}</span>`;
    } else if (type === "player") {
      messageDiv.innerHTML = `<span class="username">${username}:</span> ${content}`;
    }

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Limit chat messages to prevent memory issues
    const messages = chatMessages.children;
    if (messages.length > 50) {
      chatMessages.removeChild(messages[0]);
    }
  }

  function connectWebSocket() {
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error("WebSocket init failed", e);
      return;
    }

    ws.addEventListener("open", () => {
      const joinMsg = { action: "join_game", username: state.me.username };
      ws.send(JSON.stringify(joinMsg));
      updateUI();

      // Don't start movement loop here - wait until we have confirmed position
    });

    ws.addEventListener("message", async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn("Invalid message", event.data);
        return;
      }

      if (data.action === "join_game") {
        if (data.success === false) {
          console.error("Join failed:", data.error);
          return;
        }

        // Store my id and initial state
        state.me.id = data.playerId;
        const meFromServer = data.players?.[state.me.id];
        if (meFromServer) {
          state.me.x = meFromServer.x | 0;
          state.me.y = meFromServer.y | 0;
          state.me.facing = meFromServer.facing || "south";
          state.me.animationFrame = meFromServer.animationFrame | 0;
          state.me.avatarName = meFromServer.avatar;
          state.me.hasServerPosition = true; // Mark that we have a confirmed position
        }

        // Store all other players
        if (data.players) {
          for (const [playerId, playerData] of Object.entries(data.players)) {
            if (playerId !== state.me.id) {
              state.otherPlayers.byId[playerId] = {
                id: playerId,
                x: playerData.x | 0,
                y: playerData.y | 0,
                facing: playerData.facing || "south",
                animationFrame: playerData.animationFrame | 0,
                username: playerData.username,
                avatarName: playerData.avatar,
                targetX: playerData.x | 0,
                targetY: playerData.y | 0,
                lastUpdate: Date.now(),
              };
            }
          }
        }

        // Use server's position instead of overriding with deterministic spawn
        // This ensures we start from the server's actual position

        // Cache all avatar frames (mine and other players)
        try {
          // Cache my avatar frames
          await cacheMyAvatarFrames(data.avatars || {}, state.me.avatarName);

          // Cache other players' avatar frames
          for (const avatar of Object.values(data.avatars || {})) {
            await cacheAvatarFrames(avatar);
          }

          state.me.ready = true;
        } catch (e) {
          console.error("Failed to cache avatar frames", e);
        }

        // Recompute camera now that we know my (possibly overridden) position
        updateCamera();

        // Allow move commands now that we have a confirmed position
        canSendMoveCommands = true;

        // Start movement loop now that we have a confirmed position
        startMovementLoop();
      } else if (data.action === "players_moved") {
        // Handle movement updates from server
        if (data.players) {
          // Update my position
          if (data.players[state.me.id]) {
            const myUpdate = data.players[state.me.id];
            state.me.x = myUpdate.x | 0;
            state.me.y = myUpdate.y | 0;
            state.me.facing = myUpdate.facing || state.me.facing;
            state.me.animationFrame = myUpdate.animationFrame | 0;

            // Update camera to follow movement
            updateCamera();
          }

          // Update other players' positions with smooth interpolation
          for (const [playerId, playerUpdate] of Object.entries(data.players)) {
            if (playerId !== state.me.id && state.otherPlayers.byId[playerId]) {
              const player = state.otherPlayers.byId[playerId];
              // Store target position for smooth interpolation
              player.targetX = playerUpdate.x | 0;
              player.targetY = playerUpdate.y | 0;
              player.facing = playerUpdate.facing || player.facing;
              player.animationFrame = playerUpdate.animationFrame | 0;
              player.lastUpdate = Date.now();
            }
          }
        }
      } else if (data.action === "player_joined") {
        // Handle new player joining
        if (data.player && data.avatar) {
          const player = data.player;
          state.otherPlayers.byId[player.id] = {
            id: player.id,
            x: player.x | 0,
            y: player.y | 0,
            facing: player.facing || "south",
            animationFrame: player.animationFrame | 0,
            username: player.username,
            avatarName: player.avatar,
            targetX: player.x | 0,
            targetY: player.y | 0,
            lastUpdate: Date.now(),
          };

          // Cache the new player's avatar frames
          cacheAvatarFrames(data.avatar);
          console.log("Player joined:", player.username);
          updateUI();
        }
      } else if (data.action === "player_left") {
        // Handle player leaving
        if (data.playerId && state.otherPlayers.byId[data.playerId]) {
          console.log(
            "Player left:",
            state.otherPlayers.byId[data.playerId].username
          );
          delete state.otherPlayers.byId[data.playerId];
          updateUI();
        }
      } else if (data.action === "chat") {
        // Handle chat messages
        if (data.username && data.message) {
          addChatMessage("player", data.message, data.username);
        }
      }
    });

    ws.addEventListener("close", () => {
      console.warn("WebSocket closed");
      stopMovementLoop();
      updateUI();
    });

    ws.addEventListener("error", (e) => {
      console.error("WebSocket error", e);
      stopMovementLoop();
      updateUI();
    });
  }

  // Bootstrap: wait for world image, then connect and start rendering
  worldImage.onload = () => {
    state.world.width = worldImage.naturalWidth || worldImage.width || 0;
    state.world.height = worldImage.naturalHeight || worldImage.height || 0;
    state.world.ready = true;

    resizeCanvas();
    // Don't call updateCamera() here - wait until we have player position from server

    // Start the render loop once.
    startRenderLoop();

    // Setup keyboard input
    setupKeyboardInput();

    // Setup chat system
    setupChat();

    // Connect after world is ready; we can still connect earlier, but this ensures we can draw immediately
    connectWebSocket();
  };

  window.addEventListener("resize", () => {
    resizeCanvas();
    updateCamera();
  });
})();
