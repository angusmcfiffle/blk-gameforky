/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('blk.game.server.ServerGame');

goog.require('blk.GameState');
goog.require('blk.env.ChunkView');
goog.require('blk.env.Entity');
goog.require('blk.env.MapParameters');
goog.require('blk.env.server.ServerMap');
goog.require('blk.game.server.ServerMapObserver');
goog.require('blk.game.server.ServerNetService');
goog.require('blk.game.server.ServerPlayer');
goog.require('blk.io.ChunkSerializer');
goog.require('blk.io.CompressionFormat');
goog.require('blk.net.packets.EntityCreate');
goog.require('blk.net.packets.EntityDelete');
goog.require('blk.net.packets.EntityPosition');
goog.require('blk.net.packets.ReadyPlayer');
goog.require('blk.net.packets.SetBlock');
goog.require('blk.physics.ServerMovement');
goog.require('gf');
goog.require('gf.Game');
goog.require('gf.log');
goog.require('gf.net.SessionType');
goog.require('gf.net.browser.BrowserClient');
goog.require('gf.net.chat.ServerChatService');
goog.require('goog.vec.Vec3');



/**
 * Test game server instance.
 *
 * @constructor
 * @extends {gf.Game}
 * @param {!blk.server.LaunchOptions} launchOptions Launch options.
 * @param {!gf.net.ServerSession} session Client session.
 * @param {!blk.io.MapStore} mapStore Map storage provider, ownership
 *     transferred.
 */
blk.game.server.ServerGame = function(launchOptions, session, mapStore) {
  goog.base(this, launchOptions, session.clock);

  /**
   * Server browser client.
   * Registers the game with the browser (if non-local) and keeps it updated.
   * @private
   * @type {gf.net.browser.BrowserClient}
   */
  this.browserClient_ = null;
  if (session.type == gf.net.SessionType.REMOTE &&
      launchOptions.browserUrl &&
      launchOptions.serverId && launchOptions.serverKey) {
    this.browserClient_ = new gf.net.browser.BrowserClient(
        launchOptions.browserUrl,
        launchOptions.serverId, launchOptions.serverKey);
    this.registerDisposable(this.browserClient_);
    this.browserClient_.registerServer(session.serverInfo).addCallbacks(
        function() {
          gf.log.write('Registered with server browser at ' +
              launchOptions.browserUrl);
          this.updateBrowser_();
        },
        function(arg) {
          gf.log.write('Unable to register with server browser: ', arg);
        }, this);
  }

  /**
   * Timer ID of the server browser update, if it is running.
   * @private
   * @type {number?}
   */
  this.browserUpdateId_ = null;

  /**
   * Server session.
   * @type {!gf.net.ServerSession}
   */
  this.session = session;

  /**
   * Server net service.
   * @type {!blk.game.server.ServerNetService}
   */
  this.netService = new blk.game.server.ServerNetService(this);
  this.session.registerService(this.netService);

  /**
   * Chat server.
   * @type {!gf.net.chat.ServerChatService}
   */
  this.chat = new gf.net.chat.ServerChatService(session);
  this.session.registerService(this.chat);

  // TODO(benvanik): pull from somewhere - args?
  var mapParams = new blk.env.MapParameters();

  /**
   * Map.
   * @type {!blk.env.server.ServerMap}
   */
  this.map = new blk.env.server.ServerMap(mapParams, mapStore);
  this.registerDisposable(this.map);

  /**
   * Current game state.
   * @type {!blk.GameState}
   */
  this.state = new blk.GameState(this, session, this.map);
  this.registerDisposable(this.state);

  // If running in a web worker, don't use compression (it's a waste)
  var compressionFormat;
  if (gf.SERVER && !gf.NODE) {
    compressionFormat = blk.io.CompressionFormat.UNCOMPRESSED;
  }

  /**
   * Cached chunk serialization utility used when sending chunks to clients.
   * @type {!blk.io.ChunkSerializer}
   */
  this.chunkSerializer = new blk.io.ChunkSerializer(compressionFormat);

  // TODO(benvanik): something better
  this.nextEntityId_ = 0;

  // Start accepting connections
  this.session.ready();
};
goog.inherits(blk.game.server.ServerGame, gf.Game);


/**
 * @override
 */
blk.game.server.ServerGame.prototype.disposeInternal = function() {
  if (this.browserUpdateId_) {
    goog.global.clearTimeout(this.browserUpdateId_);
    this.browserUpdateId_ = null;
  }
  if (this.browserClient_) {
    this.browserClient_.unregisterServer();
  }

  goog.base(this, 'disposeInternal');
};


/**
 * Updates the server browser with the current user info.
 * @private
 */
blk.game.server.ServerGame.prototype.updateBrowser_ = function() {
  if (!this.browserClient_) {
    return;
  }

  // Build user infos
  var userInfos = [];
  for (var n = 0; n < this.session.users.length; n++) {
    var user = this.session.users[n];
    userInfos.push(user.info);
  }

  this.browserClient_.updateServer(userInfos).addBoth(
      function() {
        // Call again
        this.browserUpdateId_ = goog.global.setTimeout(
            goog.bind(this.updateBrowser_, this),
            gf.net.browser.BrowserClient.UPDATE_FREQUENCY * 1000);
      }, this);
};


/**
 * @override
 */
blk.game.server.ServerGame.prototype.update = function(frame) {
  var state = this.state;
  var map = state.map;

  // Networking
  this.session.poll();

  // Player movement
  for (var n = 0; n < state.players.length; n++) {
    var player =
        /** @type {!blk.game.server.ServerPlayer} */ (state.players[n]);
    player.update(frame);
  }

  // State updates
  state.update(frame);

  // Broadcast any pending updates to users
  // TODO(benvanik): only send updates relevant to each user vs. broadcast all
  // NOTE: always sending, even if not updates, so sequence numbers get ACKed
  var entityStates = [];
  for (var n = 0; n < map.entities.length; n++) {
    var entity = map.entities[n];
    if (!entity.hasSentLatestState) {
      entity.state.time = (frame.time * 1000) | 0;
      entityStates.push(entity.state);
      entity.hasSentLatestState = true;
    }
  }
  for (var n = 0; n < this.state.players.length; n++) {
    // Determine if we need to send a sequence ID
    var sequence = -1;
    var player =
        /** @type {!blk.game.server.ServerPlayer} */ (state.players[n]);
    var movement = player.movement;
    var needsSequenceUpdate = false;
    if (movement) {
      needsSequenceUpdate = movement.lastSequence != movement.lastSequenceSent;
      sequence = movement.lastSequence;
      movement.lastSequenceSent = movement.lastSequence;
    }

    // Only send packet if we need to confirm a sequence or update entities
    // TODO(benvanik): delay confirming sequences a bit to reduce network
    //     traffic when nothing is moving
    if (entityStates.length || needsSequenceUpdate) {
      this.session.send(blk.net.packets.EntityPosition.createData(
          sequence, entityStates), player.getUser());
    }
  }
};


/**
 * Handles a new user.
 * @param {!gf.net.User} user User that connected.
 */
blk.game.server.ServerGame.prototype.handleUserConnect = function(user) {
  var map = this.state.map;

  gf.log.write('client connected', user.sessionId, user.info, user.agent);

  // Create player
  var player = new blk.game.server.ServerPlayer(this, user);
  user.data = player;
  this.state.addPlayer(player);

  // Add to chat channels
  this.chat.join(user, 'main');

  // Pick a spawn position
  var spawnPosition = goog.vec.Vec3.createFloat32FromValues(0, 80, 0);

  // Create view - must be cleaned up on player disconnect
  var view = new blk.env.ChunkView(map,
      blk.env.ChunkView.HIGH_CHUNK_RADIUS_XZ);
  //blk.env.ChunkView.LOW_CHUNK_RADIUS_XZ);
  map.addChunkView(view);
  player.view = view;

  // Setup observer
  var observer = new blk.game.server.ServerMapObserver(this, player, view);
  view.addObserver(observer);

  // Initialize view - must be done after observers are added
  view.initialize(spawnPosition);

  // Send all existing entities
  for (var n = 0; n < map.entities.length; n++) {
    var entity = map.entities[n];
    this.session.send(blk.net.packets.EntityCreate.createData(
        entity.id,
        entity.flags,
        entity.player ? entity.player.getUser().wireId : 0xFF,
        entity.state.position,
        entity.state.rotation,
        entity.state.velocity), user);
  }

  // Create entity
  var entity = new blk.env.Entity(this.nextEntityId_++);
  map.addEntity(entity);
  goog.vec.Vec3.setFromArray(entity.state.position, spawnPosition);

  // Entangle entity and user
  entity.flags = blk.env.Entity.Flags.USER_CONTROLLED;
  entity.player = player;
  player.entity = entity;

  // Setup movement controller
  player.movement = new blk.physics.ServerMovement(view);
  player.movement.attach(entity);

  // Broadcast new entity
  this.session.send(blk.net.packets.EntityCreate.createData(
      entity.id,
      entity.flags,
      entity.player ? entity.player.getUser().wireId : 0xFF,
      entity.state.position,
      entity.state.rotation,
      entity.state.velocity));

  // TODO(benvanik): send all map chunks

  // Signal player ready
  this.session.send(blk.net.packets.ReadyPlayer.createData(), user);
};


/**
 * Handles a dead user.
 * @param {!gf.net.User} user User that disconnected.
 */
blk.game.server.ServerGame.prototype.handleUserDisconnect = function(user) {
  var map = this.state.map;

  gf.log.write('client disconnected', user.sessionId);

  var player = /** @type {blk.game.Player} */ (user.data);
  if (!player) {
    return;
  }

  // Delete entity
  var entity = player.entity;
  if (entity) {
    map.removeEntity(entity);
    this.session.send(blk.net.packets.EntityDelete.createData(entity.id));
  }

  // Remove view
  if (player.view) {
    map.removeChunkView(player.view);
    goog.dispose(player.view);
    player.view = null;
  }

  // Remove from roster
  this.state.removePlayer(user);
  goog.dispose(player);
};


/**
 * Sets a block and broadcasts the update.
 * @param {!gf.net.User} user User who performed the change.
 * @param {number} x Block X.
 * @param {number} y Block Y.
 * @param {number} z Block Z.
 * @param {number} blockData Block data.
 * @return {boolean} False if an error occurred setting the block.
 */
blk.game.server.ServerGame.prototype.setBlock =
    function(user, x, y, z, blockData) {
  var player = /** @type {blk.game.Player} */ (user.data);
  if (!player || !player.view) {
    return false;
  }

  var map = this.state.map;
  var view = player.view;

  // TODO(benvanik): verify user can act on the block (distance check/etc)

  // Validate block type
  if (blockData && !map.blockSet.has(blockData >> 8)) {
    gf.log.write('unknown block type');
    return false;
  }

  // Set
  var changed = view.setBlock(x, y, z, blockData);

  // Broadcast update, if it changed
  if (changed) {
    this.session.send(blk.net.packets.SetBlock.createData(
        x, y, z, blockData));
  }

  return true;
};


/**
 * Moves a player.
 * @param {!gf.net.User} user User who performed the move.
 * @param {!Array.<!blk.physics.MoveCommand>} commands Move commands.
 * @return {boolean} False if an error occurred moving the player.
 */
blk.game.server.ServerGame.prototype.movePlayer = function(user, commands) {
  var player = /** @type {!blk.game.server.ServerPlayer} */ (user.data);

  if (player.movement) {
    player.movement.queueCommands(commands);
  }

  return true;
};


/**
 * @override
 */
blk.game.server.ServerGame.prototype.render = function(frame) {
};
