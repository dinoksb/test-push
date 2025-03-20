class Server {
  async joinRoom(roomId) {
    if (roomId) {
      if (await $global.countRoomUsers(roomId) >= 8) throw Error('room is full');
    }

    // Generate a random room name in the format "Room-{randomNumber}" if no roomId is provided
    const defaultRoomId = `Room${Math.floor(Math.random() * 10000)}`;
    const joinedRoomId = await $global.joinRoom(roomId || defaultRoomId);

    // Initialize room state if not already set
    const roomState = await $room.getRoomState();
    if (!roomState?.obstacles) {
      await $room.updateRoomState({
        status: 'READY',
        obstacles: this.generateObstacles(40),
        powerups: [],
        gameTime: 0,
      });
    }

    // Initialize player data
    await $room.updateMyState({
      score: 0,
      health: 100,
      isRespawned: false,
      isDead: false
    });

    return joinedRoomId;
  }

  async leaveRoom() {
    try {
      // Before leaving, clean up player data by setting health to 0
      // This ensures the player appears dead/inactive in any UI lists
      await $room.updateMyState({
        health: 0,
        isDisconnected: true
      });
      
      // Now properly leave the room
      await $global.leaveRoom();
      
      return { success: true };
    } catch (error) {
      console.error("Error leaving game:", error);
      return { success: false };
    }
  }

  async setPlayerData(data) {
    await $room.updateMyState(data);
  }

  async updatePlayerPosition(data) {
    await $room.updateMyState(data);
  }

  async updatePlayerAnimation(data) {
    await $room.broadcastToRoom('playerAnimation', {
      playerId: $sender.account,
      ...data
    });
  }

  async playerAttack(data) {
    // 투사체 공격 타입 처리
    if (data.type === "projectile") {
      await $room.broadcastToRoom('projectileFired', data);
    } else {
      // 이전 방식의 공격 처리 유지 (하위 호환성)
      await $room.broadcastToRoom('playerAttack', data);
    }
  }

  async playerHit(data) {
    const { targetId, attackerId, damage, timestamp } = data;
    
    // Get current target health
    const targetState = await $room.getUserState(targetId);
    const currentHealth = targetState.health || 100;
    
    // Calculate new health
    const newHealth = Math.max(0, currentHealth - damage);
    
    // Update target health
    await $room.updateUserState(targetId, { 
      health: newHealth,
      // 만약 체력이 0이면 isDead 플래그를 설정
      isDead: newHealth <= 0 
    });
    
    // Broadcast hit to all players in room
    await $room.broadcastToRoom('playerHitSync', {
      targetId,
      attackerId,
      damage,
      newHealth,
      timestamp,
      // 체력이 0이면 플렉스한 죽은 상태 전파
      isDead: newHealth <= 0
    });
    
    // Check if player died (health reached 0)
    if (newHealth <= 0) {
      await this.playerDied({ playerId: targetId, killerId: attackerId });
    }
  }

  async playerDied(data) {
    const { playerId, killerId } = data;
    
    // Don't award points for suicide or environmental deaths
    if (killerId && killerId !== playerId) {
      // Get killer's current score
      const killerState = await $room.getUserState(killerId);
      const currentScore = killerState.score || 0;
      
      // Increment score by 1 for a kill
      await $room.updateUserState(killerId, { 
        score: currentScore + 1 
      });
    }
    
    // Mark player as dead in their state
    await $room.updateUserState(playerId, {
      isDead: true,
      health: 0
    });
    
    // Broadcast death event to all players
    await $room.broadcastToRoom('playerDied', {
      playerId,
      killerId
    });
  }

  async broadcastHitSync(data) {
    await $room.broadcastToRoom('playerHitSync', data);
  }

  async respawnPlayer(data) {
    const { x, y } = data;
    
    // Get current player state to preserve other properties
    const currentState = await $room.getMyState();
    
    // Create a complete player state with all necessary properties
    const completePlayerState = {
      x,
      y,
      health: 100,
      isDisconnected: false,
      isDead: false,
      isRespawned: true,
      respawnTime: Date.now(),
      animation: "idle",
      name: currentState.name,
      flipX: false,
      score: currentState.score || 0,
      lastUpdate: Date.now(),
      // 플레이언트에게 deadPlayers 세트에서 제거하라고 신호 보내기
      forceRemoveFromDeadPlayers: true
    };
    
    // Update player state with complete data
    await $room.updateMyState(completePlayerState);
    
    // 리스폰 이벤트에 forceRemoveFromDeadPlayers 플래그 추가
    await $room.broadcastToRoom('playerRespawned', {
      playerId: $sender.account,
      forceRemoveFromDeadPlayers: true,
      ...completePlayerState
    });
    
    // 강제 상태 업데이트에도 플래그 추가
    const allUserStates = await $room.getAllUserStates();
    await $room.broadcastToRoom('forceStateUpdate', {
      states: allUserStates,
      respawnedPlayerId: $sender.account,
      forceRemoveFromDeadPlayers: true,
      timestamp: Date.now()
    });
    
    // 리스폰 알림도 스케줄링
    this.scheduleRespawnReminders($sender.account, completePlayerState);
  }
  
  // 리스폰 알림 함수 (중복 접속 제거)
  async scheduleRespawnReminders(playerId, playerState) {
    // 첫 번째 알림 (500ms)
    setTimeout(async () => {
      try {
        await $room.broadcastToRoom('playerRespawnReminder', {
          playerId,
          playerState,
          forceRemoveFromDeadPlayers: true,
          timestamp: Date.now(),
          sequence: 1
        });
      } catch (error) {
        console.error("Error sending respawn reminder 1:", error);
      }
    }, 500);
    
    // 두 번째 알림 (1.5s)
    setTimeout(async () => {
      try {
        await $room.broadcastToRoom('playerRespawnReminder', {
          playerId,
          playerState,
          forceRemoveFromDeadPlayers: true,
          timestamp: Date.now(),
          sequence: 2
        });
      } catch (error) {
        console.error("Error sending respawn reminder 2:", error);
      }
    }, 1500);
    
    // 세 번째 알림 (3s)
    setTimeout(async () => {
      try {
        await $room.broadcastToRoom('playerRespawnReminder', {
          playerId,
          playerState,
          forceRemoveFromDeadPlayers: true,
          timestamp: Date.now(),
          sequence: 3
        });
      } catch (error) {
        console.error("Error sending respawn reminder 3:", error);
      }
    }, 3000);
  }

  async collectPowerup(id) {
    const roomState = await $room.getRoomState();
    if (!roomState.powerups) return;
    
    // Find and remove powerup from list
    const powerupIndex = roomState.powerups.findIndex(p => p.id === id);
    if (powerupIndex !== -1) {
      roomState.powerups.splice(powerupIndex, 1);
      await $room.updateRoomState({ powerups: roomState.powerups });
    }
  }

  // Generate random obstacles (for initialization)
  generateObstacles(count) {
    const obstacles = [];
    const worldSize = 2000;
    const minDistance = 150; // Minimum distance between obstacles
    
    // Helper to check if a position is too close to existing obstacles
    const isTooClose = (x, y) => {
      return obstacles.some(obs => {
        const distance = Math.sqrt(
          Math.pow(obs.x - x, 2) + 
          Math.pow(obs.y - y, 2)
        );
        return distance < minDistance;
      });
    };
    
    // Generate obstacles in a grid pattern
    for (let i = 0; i < count; i++) {
      let x, y;
      let attempts = 0;
      
      // Try to find a valid position (not too close to other obstacles)
      do {
        x = Math.floor(Math.random() * (worldSize - 200)) + 100;
        y = Math.floor(Math.random() * (worldSize - 200)) + 100;
        attempts++;
      } while (isTooClose(x, y) && attempts < 20);
      
      if (attempts < 20) {
        obstacles.push({ x, y });
      }
    }
    
    return obstacles;
  }

  // Room tick function for regular updates
  $roomTick(deltaMS, roomId) {
    this.updateGameState(deltaMS, roomId);
    this.spawnPowerups(deltaMS, roomId);
    this.checkRespawnedPlayers(deltaMS, roomId);
  }
  
  // Update game state (time, etc.)
  async updateGameState(deltaMS, roomId) {
    const roomState = await $room.getRoomState(roomId);
    if (!roomState) return;
    
    // Update game time
    const gameTime = (roomState.gameTime || 0) + deltaMS;
    await $room.updateRoomState(roomId, { gameTime });
  }
  
  // Check for recently respawned players and ensure they're visible
  async checkRespawnedPlayers(deltaMS, roomId) {
    try {
      const allUserStates = await $room.getAllUserStates();
      
      // Find any players that have respawned recently
      const respawnedPlayers = allUserStates.filter(state => 
        state.isRespawned && 
        state.health > 0 && 
        state.respawnTime && 
        Date.now() - state.respawnTime < 15000 // Within last 15 seconds
      );
      
      // If we have respawned players, send a periodic reminder to all clients
      if (respawnedPlayers.length > 0) {
        // Only send periodic updates at certain intervals to avoid flooding
        const shouldSendUpdate = Date.now() % 3000 < deltaMS; // Every ~3 seconds
        
        if (shouldSendUpdate) {
          // Send a batch update with all respawned players
          await $room.broadcastToRoom('respawnedPlayersBatch', {
            players: respawnedPlayers.map(player => ({
              playerId: player.account,
              x: player.x,
              y: player.y,
              health: player.health,
              name: player.name,
              animation: player.animation || "idle",
              flipX: player.flipX || false,
              respawnTime: player.respawnTime,
              score: player.score || 0,
              forceRemoveFromDeadPlayers: true,
              timestamp: Date.now()
            })),
            timestamp: Date.now()
          });
          
          // Also send a full state update periodically
          await $room.broadcastToRoom('forceStateUpdate', {
            states: allUserStates,
            forceRemoveFromDeadPlayers: true,
            timestamp: Date.now()
          });
        }
        
        // Process individual players for cleanup
        for (const player of respawnedPlayers) {
          // After 15 seconds, clear the respawn flag
          if (player.respawnTime && Date.now() - player.respawnTime > 15000) {
            await $room.updateUserState(player.account, {
              isRespawned: false
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking respawned players:", error);
    }
  }
  
  // Spawn powerups periodically
  async spawnPowerups(deltaMS, roomId) {
    const roomState = await $room.getRoomState(roomId);
    if (!roomState) return;
    
    // Check if we should spawn a powerup (every ~10 seconds)
    const shouldSpawn = Math.random() < deltaMS / 10000;
    
    if (shouldSpawn) {
      const powerups = roomState.powerups || [];
      
      // Limit maximum number of powerups
      if (powerups.length < 5) {
        // Generate random position
        const x = Math.floor(Math.random() * 1800) + 100;        const y = Math.floor(Math.random() * 1800) + 100;
        
        // Create powerup
        const powerup = {
          id: `powerup_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          type: Math.random() < 0.7 ? 'health' : 'speed',
          x,
          y
        };
        
        // Add to list and update room state
        powerups.push(powerup);
        await $room.updateRoomState(roomId, { powerups });
        
        // Notify clients
        await $room.broadcastToRoom('powerupSpawned', powerup);
      }
    }
  }
}
