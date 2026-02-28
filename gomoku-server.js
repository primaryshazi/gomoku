/**
 * 五子棋局域网服务器
 *
 * 使用方法：
 *   1. 安装依赖：npm install ws
 *   2. 启动服务：node gomoku-server.js
 *   3. 将终端中显示的局域网地址发给对方，双方用浏览器打开即可开始游戏
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3001;

// ─── 获取本机所有局域网 IPv4 地址 ───
function getLocalIPs() {
    const result = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                result.push(net.address);
            }
        }
    }
    return result;
}

// ─── 生成 4 位大写房间号（去掉易混淆字符） ───
function genRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ─── 房间数据结构 ───
// rooms: Map<roomId, { players: [ws|null, ws|null], history: [], current: 1|2, over: bool }>
const rooms = new Map();

function sanitizeProfile(p) {
    if (!p || typeof p !== 'object') return { name: '对手', avatar: 5 };
    return {
        name: String(p.name || '对手').slice(0, 10),
        avatar: Number.isInteger(p.avatar) ? Math.max(0, Math.min(29, p.avatar)) : 5,
    };
}

// ─── HTTP 服务：静态托管 gomoku.html ───
const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'gomoku.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('无法加载 gomoku.html，请确保文件与服务器在同一目录');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

// ─── WebSocket 服务 ───
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
    ws.roomId = null;
    ws.pi = -1;   // player index: 0=黑(先手) 1=白(后手)
    broadcastStats(); // 新用户连接，刷新大厅统计

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ── 主动请求统计（进入大厅时） ──
        if (msg.type === 'ping_stats') {
            send(ws, { type: 'stats', online: wss.clients.size, rooms: rooms.size });
            return;
        }

        // ── 主动请求公开房间列表 ──
        if (msg.type === 'ping_rooms') {
            send(ws, { type: 'room_list', rooms: getPublicRoomList() });
            return;
        }

        const room = ws.roomId ? rooms.get(ws.roomId) : null;

        // ── 创建房间 ──
        if (msg.type === 'create') {
            let rid;
            do { rid = genRoomId(); } while (rooms.has(rid));
            rooms.set(rid, {
                players: [ws, null],
                history: [], current: 1, over: false,
                public: msg.public !== false,   // 默认公开
            });
            ws.roomId = rid;
            ws.pi = 0;
            ws.profile = sanitizeProfile(msg.profile);
            send(ws, { type: 'created', room: rid });
            broadcastStats();
            broadcastRoomList();
            return;
        }

        // ── 加入房间 ──
        if (msg.type === 'join') {
            const rid = (msg.room || '').toUpperCase();
            const r = rooms.get(rid);
            if (!r) {
                send(ws, { type: 'error', msg: '房间不存在，请检查房间号' });
                return;
            }
            if (r.players[1]) {
                send(ws, { type: 'error', msg: '房间已满' });
                return;
            }
            r.players[1] = ws;
            ws.roomId = rid;
            ws.pi = 1;
            ws.profile = sanitizeProfile(msg.profile);
            const firstPlayer = Math.random() < 0.5 ? 1 : 2;
            r.current = firstPlayer;
            send(r.players[0], { type: 'start', player: 1, oppProfile: ws.profile,    firstPlayer });
            send(r.players[1], { type: 'start', player: 2, oppProfile: r.players[0].profile, firstPlayer });
            broadcastStats();
            broadcastRoomList();
            return;
        }

        if (!room) return;

        // ── 落子 ──
        if (msg.type === 'move') {
            if (room.over) return;
            if (ws.pi + 1 !== room.current) return; // 不是你的回合
            const { r, c } = msg;
            room.history.push({ r, c, player: room.current });
            room.current = room.current === 1 ? 2 : 1;
            broadcast(room, { type: 'move', r, c, player: ws.pi + 1 });
            return;
        }

        // ── 游戏结束通知（客户端检测到五子连珠后发送） ──
        if (msg.type === 'game_over') {
            room.over = true;
            return;
        }

        // ── 认输 ──
        if (msg.type === 'resign') {
            if (room.over) return;
            room.over = true;
            broadcast(room, { type: 'resign', loser: ws.pi + 1 });
            return;
        }

        // ── 超时判负（客户端检测到落子超时后发送，取第一条） ──
        if (msg.type === 'timeout') {
            if (room.over) return;
            room.over = true;
            const loser = (typeof msg.loser === 'number' && (msg.loser === 1 || msg.loser === 2))
                ? msg.loser : (ws.pi + 1);
            broadcast(room, { type: 'timeout', loser });
            return;
        }

        // ── 悔棋请求 ──
        if (msg.type === 'undo_req') {
            if (room.over || room.history.length === 0) return;
            sendOpp(ws, room, { type: 'undo_req' });
            return;
        }

        // ── 对方同意悔棋 ──
        if (msg.type === 'undo_ok') {
            if (room.history.length === 0) return;
            const last = room.history.pop();
            room.current = last.player;
            broadcast(room, { type: 'undo', r: last.r, c: last.c, newCurrent: last.player });
            return;
        }

        // ── 对方拒绝悔棋 ──
        if (msg.type === 'undo_no') {
            sendOpp(ws, room, { type: 'undo_no' });
            return;
        }

        // ── 重玩请求 ──
        if (msg.type === 'restart_req') {
            sendOpp(ws, room, { type: 'restart_req' });
            return;
        }

        // ── 对方同意重玩 ──
        if (msg.type === 'restart_ok') {
            const firstPlayer = Math.random() < 0.5 ? 1 : 2;
            room.history = [];
            room.current = firstPlayer;
            room.over = false;
            broadcast(room, { type: 'restart', firstPlayer });
            return;
        }

        // ── 对方拒绝重玩 ──
        if (msg.type === 'restart_no') {
            sendOpp(ws, room, { type: 'restart_no' });
            return;
        }

        // ── 换边请求 ──
        if (msg.type === 'swap_req') {
            if (room.over) return;
            sendOpp(ws, room, { type: 'swap_req' });
            return;
        }

        // ── 对方同意换边 ──
        if (msg.type === 'swap_ok') {
            if (room.over) return;
            // 服务器交换两位玩家的 pi（player index）
            const p0 = room.players[0];
            const p1 = room.players[1];
            if (p0) p0.pi = 1;
            if (p1) p1.pi = 0;
            room.players = [p1, p0];
            broadcast(room, { type: 'swap' });
            return;
        }

        // ── 对方拒绝换边 ──
        if (msg.type === 'swap_no') {
            sendOpp(ws, room, { type: 'swap_no' });
            return;
        }

        // ── 聊天消息 ──
        if (msg.type === 'chat') {
            const text = String(msg.text || '').trim().slice(0, 127);
            if (!text) return;
            sendOpp(ws, room, { type: 'chat', text });
            return;
        }
    });

    ws.on('close', () => {
        const room = ws.roomId ? rooms.get(ws.roomId) : null;
        if (room) {
            const opp = room.players[1 - ws.pi];
            if (opp && opp.readyState === WebSocket.OPEN) {
                send(opp, { type: 'opp_left' });
            }
            rooms.delete(ws.roomId);
        }
        broadcastStats();
        broadcastRoomList(); // 断线后刷新公开房间列表
    });
});

function send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function broadcast(room, msg) {
    const s = JSON.stringify(msg);
    for (const p of room.players) {
        if (p && p.readyState === WebSocket.OPEN) p.send(s);
    }
}

function sendOpp(ws, room, msg) {
    const opp = room.players[1 - ws.pi];
    send(opp, msg);
}

// 向所有尚未进入房间的客户端广播在线统计
function broadcastStats() {
    const online = wss.clients.size;
    const roomCount = rooms.size;
    const payload = JSON.stringify({ type: 'stats', online, rooms: roomCount });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && !client.roomId) {
            client.send(payload);
        }
    }
}

// 向所有大厅客户端广播公开等待中的房间列表
function getPublicRoomList() {
    const list = [];
    for (const [id, room] of rooms) {
        if (room.public && !room.players[1]) {
            list.push({
                id,
                host: room.players[0]?.profile || { name: '房主', avatar: 5 },
            });
        }
    }
    return list;
}

function broadcastRoomList() {
    const payload = JSON.stringify({ type: 'room_list', rooms: getPublicRoomList() });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && !client.roomId) {
            client.send(payload);
        }
    }
}

// ─── 启动 ───
httpServer.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    console.log('\n🎮  五子棋局域网服务已启动！\n');
    if (ips.length > 0) {
        console.log('📡  局域网地址（发给对方打开）：\n');
        ips.forEach(ip => console.log(`     ➜  http://${ip}:${PORT}`));
    }
    console.log(`\n💻  本机访问：http://localhost:${PORT}`);
    console.log('\n按 Ctrl+C 停止服务\n');
    console.log('─'.repeat(40));
});
