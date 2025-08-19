const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// ---- Custom middleware ----
// Request logger with timestamp and path tracking
const requestTracker = (req, res, next) => {
  req.requestId = uuidv4();
  req.requestTime = Date.now();
  console.log(`[${new Date().toISOString()}] [${req.requestId}] ${req.method} ${req.path}`);
  
  // Track response completion
  res.on('finish', () => {
    const processingTime = Date.now() - req.requestTime;
    console.log(`[${new Date().toISOString()}] [${req.requestId}] Completed ${res.statusCode} in ${processingTime}ms`);
  });
  
  next();
};

// Hook-specific content validator
const validateHookahOrder = (req, res, next) => {
  const { items } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }
  
  const validTypes = ['mix', 'custom'];
  for (const item of items) {
    if (!validTypes.includes(item.type)) {
      return res.status(400).json({ error: `Invalid item type: ${item.type}` });
    }
    
    if (item.type === 'custom' && (!item.hookah || !item.flavors || !Array.isArray(item.flavors))) {
      return res.status(400).json({ error: 'Custom mix requires hookah and flavors array' });
    }
    
    if (item.type === 'custom' && item.flavors.length > 3) {
      return res.status(400).json({ error: 'Maximum 3 flavors allowed per custom mix' });
    }
  }
  
  next();
};

// Apply basic middleware
app.use(requestTracker);

// ---- Data structures ----
// Order store with time-based indexes for efficient querying
class OrderStore {
  constructor() {
    this.orders = new Map(); // orderId -> order
    this.ordersByTime = []; // Sorted array of {timestamp, orderId}
    this.ordersByStatus = {
      pending: new Set(),
      confirmed: new Set(),
      preparing: new Set(),
      ready: new Set(),
      completed: new Set()
    };
  }
  
  addOrder(order) {
    this.orders.set(order.orderId, order);
    this.ordersByTime.push({timestamp: new Date(order.timestamp).getTime(), orderId: order.orderId});
    this.ordersByTime.sort((a, b) => b.timestamp - a.timestamp);
    this.ordersByStatus[order.status].add(order.orderId);
    return order;
  }
  
  getOrder(orderId) {
    return this.orders.get(orderId);
  }
  
  updateOrderStatus(orderId, status) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    
    // Remove from old status set
    this.ordersByStatus[order.status].delete(orderId);
    
    // Update order and add to new status set
    order.status = status;
    order.statusUpdatedAt = new Date().toISOString();
    this.ordersByStatus[status].add(orderId);
    
    return order;
  }
  
  getRecentOrders(limit = 10) {
    return this.ordersByTime.slice(0, limit).map(item => this.orders.get(item.orderId));
  }
  
  getOrdersByStatus(status) {
    return Array.from(this.ordersByStatus[status]).map(orderId => this.orders.get(orderId));
  }
}

// Event emitter for real-time admin notifications
class AdminNotifier {
  constructor() {
    this.listeners = [];
    this.notifications = [];
    this.maxNotifications = 100;
  }
  
  addNotification(type, data) {
    const notification = {
      id: uuidv4(),
      type,
      data,
      timestamp: new Date().toISOString(),
      read: false
    };
    
    this.notifications.unshift(notification);
    
    // Keep notifications buffer at manageable size
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.pop();
    }
    
    // Notify all listeners
    this.listeners.forEach(listener => listener(notification));
    
    return notification;
  }
  
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
  
  getRecentNotifications(limit = 20) {
    return this.notifications.slice(0, limit);
  }
  
  markAsRead(notificationId) {
    const notification = this.notifications.find(n => n.id === notificationId);
    if (notification) {
      notification.read = true;
      return true;
    }
    return false;
  }
}

// Initialize data stores
const orderStore = new OrderStore();
const adminNotifier = new AdminNotifier();

// ---- API routes ----
// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'up', time: new Date().toISOString() });
});

// Submit new order
app.post('/orders', validateHookahOrder, (req, res) => {
  try {
    const { items, total, customerInfo } = req.body;
    
    // Create order with unique ID and timestamp
    const orderDetails = {
      orderId: `TURBO-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`,
      items,
      total,
      customerInfo: customerInfo || { id: `guest-${Date.now()}` },
      timestamp: new Date().toISOString(),
      status: 'pending',
      statusUpdatedAt: new Date().toISOString()
    };
    
    // Store the order
    orderStore.addOrder(orderDetails);
    
    // Notify admin about new order
    adminNotifier.addNotification('new-order', {
      orderId: orderDetails.orderId,
      total: orderDetails.total,
      items: orderDetails.items.length
    });
    
    res.status(201).json({
      success: true,
      message: 'Order submitted successfully',
      order: orderDetails
    });
  } catch (error) {
    console.error('Error submitting order:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process order',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get order status
app.get('/orders/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = orderStore.getOrder(orderId);
  
  if (!order) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }
  
  res.status(200).json({
    success: true,
    order
  });
});

// Update order status (admin only)
app.put('/orders/:orderId/status', (req, res) => {
  // NOTE: In a real app, we would authenticate admin users here
  const { orderId } = req.params;
  const { status } = req.body;
  
  if (!['pending', 'confirmed', 'preparing', 'ready', 'completed'].includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid status value'
    });
  }
  
  const updatedOrder = orderStore.updateOrderStatus(orderId, status);
  
  if (!updatedOrder) {
    return res.status(404).json({
      success: false,
      message: 'Order not found'
    });
  }
  
  // Notify admin about status change
  adminNotifier.addNotification('status-change', {
    orderId: updatedOrder.orderId,
    status: updatedOrder.status,
    previousStatus: updatedOrder.previousStatus
  });
  
  res.status(200).json({
    success: true,
    order: updatedOrder
  });
});

// Admin: Get recent orders
app.get('/admin/orders', (req, res) => {
  // NOTE: In a real app, we would authenticate admin users here
  const { status } = req.query;
  
  let orders;
  if (status) {
    orders = orderStore.getOrdersByStatus(status);
  } else {
    orders = orderStore.getRecentOrders(20);
  }
  
  res.status(200).json({
    success: true,
    orders
  });
});

// Admin: Get recent notifications
app.get('/admin/notifications', (req, res) => {
  // NOTE: In a real app, we would authenticate admin users here
  const notifications = adminNotifier.getRecentNotifications();
  
  res.status(200).json({
    success: true,
    notifications
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Turbo Menu API server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log('Ready to accept orders...');
});

// Export for testing
module.exports = app;
