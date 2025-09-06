const express = require('express');
const multer = require('multer');
const login = require("facebook-chat-api");
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Serve static files from the public directory
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// File upload configuration
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 1024 * 1024 } // 1MB limit
});

// Store active API instances
const activeConnections = new Map();

// Helper function to validate appstate
function validateAppState(appState) {
  try {
    const parsed = typeof appState === 'string' ? JSON.parse(appState) : appState;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch (e) {
    return false;
  }
}

// Login endpoint
app.post('/api/login', upload.single('appstate'), async (req, res) => {
  try {
    let appState;
    
    if (req.file) {
      // AppState uploaded as file
      const appStateContent = fs.readFileSync(req.file.path, 'utf-8');
      appState = JSON.parse(appStateContent);
      fs.unlinkSync(req.file.path); // Clean up uploaded file
    } else if (req.body.appState) {
      // AppState sent in request body
      appState = req.body.appState;
    } else {
      return res.status(400).json({ error: 'No appState provided' });
    }

    if (!validateAppState(appState)) {
      return res.status(400).json({ error: 'Invalid appState format' });
    }

    // Create unique session ID
    const sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Attempt login
    login({ appState }, (err, api) => {
      if (err) {
        console.error('Login failed:', err);
        return res.status(401).json({ 
          error: 'Login failed', 
          details: err.error || 'Invalid credentials' 
        });
      }

      // Store API instance
      activeConnections.set(sessionId, {
        api,
        createdAt: Date.now(),
        lastUsed: Date.now()
      });

      // Set session timeout (30 minutes)
      setTimeout(() => {
        if (activeConnections.has(sessionId)) {
          try {
            activeConnections.get(sessionId).api.logout();
          } catch (e) {
            // Ignore logout errors
          }
          activeConnections.delete(sessionId);
          console.log(`Session ${sessionId} expired and cleaned up`);
        }
      }, 30 * 60 * 1000);

      res.json({ 
        success: true, 
        sessionId,
        message: 'Logged in successfully' 
      });
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get groups endpoint
app.get('/api/groups/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const connection = activeConnections.get(sessionId);

    if (!connection) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const { api } = connection;
    connection.lastUsed = Date.now();

    api.getThreadList(50, null, ["INBOX"], (err, threads) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch groups' });
      }

      const groups = threads
        .filter(t => t.isGroup && t.name)
        .map(t => ({
          id: t.threadID,
          name: t.name,
          memberCount: t.participantIDs ? t.participantIDs.length : 0
        }));

      res.json({ groups });
    });

  } catch (error) {
    console.error('Groups fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change all endpoint (nicknames and group name)
app.post('/api/change-all', async (req, res) => {
  try {
    const { sessionId, groupId, nickname, groupName } = req.body;

    if (!sessionId || !groupId) {
      return res.status(400).json({ 
        error: 'Missing required fields: sessionId, groupId' 
      });
    }

    if (!nickname && !groupName) {
      return res.status(400).json({ 
        error: 'At least one of nickname or groupName is required' 
      });
    }

    const connection = activeConnections.get(sessionId);
    if (!connection) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const { api } = connection;
    connection.lastUsed = Date.now();

    let nicknameSuccess = 0;
    let nicknameFail = 0;
    let groupNameSuccess = false;

    // Change group name if provided
    if (groupName) {
      api.setTitle(groupName, groupId, (err) => {
        if (err) {
          console.error('Change group name error:', err);
        } else {
          groupNameSuccess = true;
          console.log(`✅ Group name changed to "${groupName}"`);
        }
      });
    }

    // Change nicknames if provided
    if (nickname) {
      api.getThreadInfo(groupId, async (err, info) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to get group info' });
        }

        const userIDs = info.participantIDs;

        for (let i = 0; i < userIDs.length; i++) {
          const userId = userIDs[i];
          
          await new Promise(resolve => {
            api.changeNickname(nickname, groupId, userId, (err) => {
              if (!err) {
                nicknameSuccess++;
                console.log(`✅ Changed nickname for user ID ${userId} (${i + 1}/${userIDs.length})`);
              } else {
                nicknameFail++;
                console.log(`⚠️ Failed to change nickname for user ID ${userId}`);
              }
              
              // Add delay to avoid rate limiting
              setTimeout(resolve, 1000);
            });
          });
        }

        console.log(`🎉 All changes completed! Nicknames: ${nicknameSuccess} success, ${nicknameFail} failed. Group name: ${groupNameSuccess ? 'success' : 'failed'}`);

        res.json({
          success: true,
          message: 'Changes applied successfully',
          nicknameChanges: {
            success: nicknameSuccess,
            failed: nicknameFail
          },
          groupNameChanged: groupNameSuccess
        });
      });
    } else {
      // If only group name was changed
      res.json({
        success: true,
        message: 'Group name changed successfully',
        groupNameChanged: groupNameSuccess
      });
    }

  } catch (error) {
    console.error('Change all error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start monitoring endpoint
app.post('/api/start-monitoring', async (req, res) => {
  try {
    const { sessionId, groupId, lockNickname, lockGroupName } = req.body;

    if (!sessionId || !groupId) {
      return res.status(400).json({ 
        error: 'Missing required fields: sessionId, groupId' 
      });
    }

    const connection = activeConnections.get(sessionId);
    if (!connection) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // In a real implementation, you would set up monitoring here
    // For now, we'll just simulate it

    res.json({
      success: true,
      message: 'Monitoring started',
      monitoring: true,
      lockNickname,
      lockGroupName
    });

  } catch (error) {
    console.error('Start monitoring error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop monitoring endpoint
app.post('/api/stop-monitoring', async (req, res) => {
  try {
    const { sessionId, groupId } = req.body;

    if (!sessionId || !groupId) {
      return res.status(400).json({ 
        error: 'Missing required fields: sessionId, groupId' 
      });
    }

    const connection = activeConnections.get(sessionId);
    if (!connection) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // In a real implementation, you would stop monitoring here

    res.json({
      success: true,
      message: 'Monitoring stopped',
      monitoring: false
    });

  } catch (error) {
    console.error('Stop monitoring error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get monitoring status endpoint
app.get('/api/monitoring-status/:sessionId/:groupId', async (req, res) => {
  try {
    const { sessionId, groupId } = req.params;

    const connection = activeConnections.get(sessionId);
    if (!connection) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Simulate monitoring status
    // In a real implementation, you would check the actual monitoring status
    res.json({
      active: true,
      violations: Math.floor(Math.random() * 5), // Random number for demo
      uptime: '2 hours 15 minutes',
      lockNickname: 'Student', // Example locked nickname
      lockGroupName: 'Study Group 2024', // Example locked group name
      memberCount: 25, // Example member count
      lastCheck: new Date().toISOString()
    });

  } catch (error) {
    console.error('Monitoring status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session status
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const connection = activeConnections.get(sessionId);
  
  if (!connection) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  res.json({ 
    active: true,
    createdAt: connection.createdAt,
    lastUsed: connection.lastUsed
  });
});

// Logout endpoint
app.post('/api/logout/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const connection = activeConnections.get(sessionId);
  
  if (connection) {
    // Properly logout from Facebook
    try {
      connection.api.logout();
    } catch (e) {
      console.log('Logout error (non-critical):', e.message);
    }
    
    activeConnections.delete(sessionId);
  }

  res.json({ message: 'Logged out successfully' });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    activeConnections: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;
  
  for (const [sessionId, connection] of activeConnections.entries()) {
    if (now - connection.lastUsed > thirtyMinutes) {
      try {
        connection.api.logout();
      } catch (e) {
        // Ignore logout errors
      }
      activeConnections.delete(sessionId);
      console.log(`Cleaned up expired session: ${sessionId}`);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

app.listen(port, () => {
  console.log(`🚀 Facebook Group Locker running on port ${port}`);
  console.log(`📊 Frontend: http://localhost:${port}`);
  console.log(`📊 API: http://localhost:${port}/api/health`);
});
