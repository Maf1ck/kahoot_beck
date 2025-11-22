const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.send('MyKahoot Server is running!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity in dev
        methods: ["GET", "POST"]
    }
});

// Game State Management
class GameManager {
    constructor() {
        this.games = new Map(); // pin -> game object
    }

    createGame(hostSocketId) {
        let pin = Math.floor(100000 + Math.random() * 900000).toString();
        while (this.games.has(pin)) {
            pin = Math.floor(100000 + Math.random() * 900000).toString();
        }

        const game = {
            pin,
            hostId: hostSocketId,
            players: [], // { id, name, score, streak }
            questions: [],
            currentQuestionIndex: -1,
            state: 'LOBBY', // LOBBY, QUESTION, RESULT, LEADERBOARD, END
            answers: {} // questionIndex -> { playerId -> answerIndex }
        };

        this.games.set(pin, game);
        return pin;
    }

    getGame(pin) {
        return this.games.get(pin);
    }

    addPlayer(pin, player) {
        const game = this.games.get(pin);
        if (game) {
            game.players.push(player);
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        // Find game and remove player
        for (const [pin, game] of this.games.entries()) {
            const playerIndex = game.players.findIndex(p => p.id === socketId);
            if (playerIndex !== -1) {
                game.players.splice(playerIndex, 1);
                // If game is empty and host is gone, maybe delete? 
                // For now, just remove player.
                return { pin, game };
            }
            if (game.hostId === socketId) {
                this.games.delete(pin);
                return { pin, game, isHost: true };
            }
        }
        return null;
    }
}

const gameManager = new GameManager();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // HOST EVENTS
    socket.on('create_game', (questions) => {
        const pin = gameManager.createGame(socket.id);
        const game = gameManager.getGame(pin);
        game.questions = questions;
        socket.join(pin);
        socket.emit('game_created', pin);
        console.log(`Game created: ${pin}`);
    });

    socket.on('start_game', (pin) => {
        const game = gameManager.getGame(pin);
        if (game && game.hostId === socket.id) {
            game.state = 'QUESTION';
            game.currentQuestionIndex = 0;
            io.to(pin).emit('game_started');
            sendQuestion(pin);
        }
    });

    socket.on('next_question', (pin) => {
        const game = gameManager.getGame(pin);
        if (game && game.hostId === socket.id) {
            game.currentQuestionIndex++;
            if (game.currentQuestionIndex < game.questions.length) {
                game.state = 'QUESTION';
                game.answers[game.currentQuestionIndex] = {}; // Reset answers for new question
                sendQuestion(pin);
            } else {
                game.state = 'END';
                io.to(pin).emit('game_over', getLeaderboard(game));
            }
        }
    });

    socket.on('show_results', (pin) => {
        const game = gameManager.getGame(pin);
        if (game && game.hostId === socket.id) {
            game.state = 'RESULT';
            // Calculate scores if not done on fly
            io.to(pin).emit('question_results', {
                correctAnswer: game.questions[game.currentQuestionIndex].correctIndex,
                leaderboard: getLeaderboard(game)
            });
        }
    });

    // PLAYER EVENTS
    socket.on('join_game', ({ pin, nickname }) => {
        const game = gameManager.getGame(pin);
        if (game && game.state === 'LOBBY') {
            const player = { id: socket.id, nickname, score: 0, streak: 0 };
            gameManager.addPlayer(pin, player);
            socket.join(pin);
            io.to(pin).emit('player_joined', game.players);
            socket.emit('joined_success', { pin, nickname });
        } else {
            socket.emit('error', 'Game not found or already started');
        }
    });

    socket.on('submit_answer', ({ pin, answerIndex, timeLeft }) => {
        const game = gameManager.getGame(pin);
        if (game && game.state === 'QUESTION') {
            const currentQ = game.questions[game.currentQuestionIndex];
            const isCorrect = currentQ.correctIndex === answerIndex;

            // Record answer
            if (!game.answers[game.currentQuestionIndex]) {
                game.answers[game.currentQuestionIndex] = {};
            }
            // Prevent double answering
            if (game.answers[game.currentQuestionIndex][socket.id]) return;

            game.answers[game.currentQuestionIndex][socket.id] = answerIndex;

            // Calculate score
            if (isCorrect) {
                // Simple scoring: 1000 points max, based on time left (assuming 30s max for now, or passed from client)
                // For simplicity: 600 + (400 * timeLeft / maxTime)
                // Let's just give raw points for now: 1000 for correct.
                // Refined: Base 500 + up to 500 for speed.
                const points = 500 + Math.floor(500 * (timeLeft / 20)); // Assuming 20s default
                const player = game.players.find(p => p.id === socket.id);
                if (player) {
                    player.score += points;
                    player.streak++;
                }
            } else {
                const player = game.players.find(p => p.id === socket.id);
                if (player) player.streak = 0;
            }

            io.to(game.hostId).emit('player_answered', {
                playerId: socket.id,
                count: Object.keys(game.answers[game.currentQuestionIndex]).length
            });
        }
    });

    socket.on('disconnect', () => {
        const result = gameManager.removePlayer(socket.id);
        if (result) {
            const { pin, game, isHost } = result;
            if (isHost) {
                io.to(pin).emit('host_disconnected');
            } else {
                io.to(pin).emit('player_left', game.players);
            }
        }
    });
});

function sendQuestion(pin) {
    const game = gameManager.getGame(pin);
    const question = game.questions[game.currentQuestionIndex];
    // Send question to host (with answer) and players (without answer)
    io.to(game.hostId).emit('new_question_host', question);
    io.to(pin).except(game.hostId).emit('new_question_player', {
        text: question.text,
        options: question.options, // Just text options
        timeLimit: question.timeLimit || 20,
        index: game.currentQuestionIndex,
        total: game.questions.length
    });
}

function getLeaderboard(game) {
    return game.players
        .sort((a, b) => b.score - a.score)
        .slice(0, 5); // Top 5
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
