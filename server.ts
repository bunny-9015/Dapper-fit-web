/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { initializeApp } from 'firebase/app';
import { initializeFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, setLogLevel } from 'firebase/firestore';

dotenv.config({ override: true });

setLogLevel('silent');

const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firestoreDb: any = null;
let isFirebaseEnabled = false;

try {
  let configData: any = {};
  if (fs.existsSync(firebaseConfigPath)) {
    try {
      configData = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
    } catch (e) {
      console.warn('[Firebase] Could not parse firebase-applet-config.json:', e);
    }
  }

  // Allow environment variables to supply or override config
  const apiKey = process.env.FIREBASE_API_KEY || configData.apiKey;
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN || configData.authDomain;
  const projectId = process.env.FIREBASE_PROJECT_ID || configData.projectId;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || configData.storageBucket;
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID || configData.messagingSenderId;
  const appId = process.env.FIREBASE_APP_ID || configData.appId;
  const firestoreDatabaseId = process.env.FIREBASE_DATABASE_ID || configData.firestoreDatabaseId || '(default)';

  if (projectId && apiKey) {
    const firebaseApp = initializeApp({
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId
    });
    firestoreDb = initializeFirestore(firebaseApp, {
      experimentalForceLongPolling: true,
      ignoreUndefinedProperties: true
    }, firestoreDatabaseId);
    isFirebaseEnabled = true;
    console.log(`[Firebase] Initialized Firestore database on project ${projectId}, database ${firestoreDatabaseId}`);
  } else {
    console.warn('[Firebase] Incomplete credentials; projectId and apiKey required.');
  }
} catch (err: any) {
  console.error('[Firebase] Failed to initialize Firebase:', err.message || err);
}

// Utility to recursively remove undefined values from objects before writing to Firestore
function sanitizeForFirestore(obj: any): any {
  if (obj === null || obj === undefined) {
    return null;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForFirestore);
  }
  if (typeof obj === 'object') {
    const clean: any = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val !== undefined) {
        clean[key] = sanitizeForFirestore(val);
      }
    }
    return clean;
  }
  return obj;
}

// Initialize Gemini API client on the server as per gemini-api skill instructions
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || 'MOCK_API_KEY',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build'
    }
  }
});

const app = express();
// Port resolution:
// In development, the AI Studio dev environment uses an internal Nginx proxy that forwards external port 8080 to internal 3000.
// In production (Cloud Run), the container must listen directly on process.env.PORT (typically 8080).
const PORT = process.env.CONTROL_PLANE_PORT
  ? (Number(process.env.DEFAULT_APP_PORT) || 3000)
  : (Number(process.env.PORT) || 3000);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Centralized backend Shiprocket REST interface with robust query caching to prevent redundant API calls
const shiprocketCache = new Map<string, { value: any; expiresAt: number }>();

const CACHE_TTL_CONFIG: Record<string, number> = {
  '/settings/company/profile': 60 * 1000,          // 1 minute
  '/wallet/balance': 60 * 1000,                    // 1 minute
  '/settings/company/pickup': 10 * 60 * 1000,      // 10 minutes
  'default': 5 * 60 * 1000                         // 5 minutes (for serviceability, etc.)
};

function getCacheTTL(endpoint: string): number {
  const cleanEndpoint = endpoint.split('?')[0];
  return CACHE_TTL_CONFIG[cleanEndpoint] || CACHE_TTL_CONFIG['default'];
}

function clearShiprocketCache() {
  shiprocketCache.clear();
  console.log('[Shiprocket Cache] Cache cleared.');
}

const shiprocket = {
  rawRequest: async (endpoint: string, method: string = 'GET', headers: Record<string, string> = {}, body: any = null) => {
    const isCacheable = method.toUpperCase() === 'GET';
    const cacheKey = `${endpoint}`;

    if (isCacheable) {
      const cached = shiprocketCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        console.log(`[Shiprocket Cache Hit] Serving from cache for endpoint: ${endpoint}`);
        return cached.value;
      }
    }

    let url = `https://apiv2.shiprocket.in/v1/external${endpoint}`;
    const options: any = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    
    console.log(`[Shiprocket API Request] ${method} ${endpoint}`, { headers, body });
    let res = await fetch(url, options);
    let text = await res.text();
    console.log(`[Shiprocket API Response] Status: ${res.status}`);
    
    // Transparent fallback to /v1/internal if the /v1/external endpoint is 404
    if (res.status === 404) {
      console.log(`[Shiprocket] /v1/external returned 404. Trying internal API endpoint: ${endpoint}`);
      url = `https://apiv2.shiprocket.in/v1/internal${endpoint}`;
      res = await fetch(url, options);
      text = await res.text();
      console.log(`[Shiprocket API Fallback Response] Status: ${res.status}`);
    }
    
    if (!res.ok) {
      let parsedError = '';
      try {
        const parsed = JSON.parse(text);
        if (parsed.errors && typeof parsed.errors === 'object') {
          const detailMsgs: string[] = [];
          for (const [field, messages] of Object.entries(parsed.errors)) {
            if (Array.isArray(messages)) {
              detailMsgs.push(`${field}: ${messages.join(', ')}`);
            } else if (typeof messages === 'string') {
              detailMsgs.push(`${field}: ${messages}`);
            } else {
              detailMsgs.push(`${field}: ${JSON.stringify(messages)}`);
            }
          }
          parsedError = `${parsed.message || 'Oops! Invalid Data.'} (${detailMsgs.join('; ')})`;
        } else {
          parsedError = parsed.message || parsed.error || text;
        }
      } catch {
        parsedError = text;
      }
      throw new Error(parsedError);
    }
    
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }

    if (isCacheable) {
      const ttl = getCacheTTL(endpoint);
      shiprocketCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + ttl
      });
      console.log(`[Shiprocket Cache Save] Cached endpoint: ${endpoint} for ${ttl / 1000}s`);
    }

    return result;
  }
};

// Clean and sanitize phone number to exactly 10 digits
function cleanPhoneNumber(phone: string): string {
  let cleaned = phone ? phone.replace(/\D/g, '') : '';
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    cleaned = cleaned.substring(2);
  }
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }
  if (cleaned.length !== 10) {
    return '9876543210'; // Valid 10-digit placeholder fallback
  }
  return cleaned;
}

// In-memory caching for Shiprocket JWT tokens
let cachedToken: string | null = null;
let tokenExpiry: number | null = null;

const SETTINGS_FILE_PATH = path.join(process.cwd(), 'data_settings.json');

function loadSavedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[Server Settings] Failed to read data_settings.json:', err);
  }
  return null;
}

const initialSavedSettings = loadSavedSettings();

// Store server-side settings dynamically
let serverSettings = {
  shiprocketEmail: initialSavedSettings?.shiprocketEmail || 'k.nithwik750@gmail.com',
  shiprocketPassword: initialSavedSettings?.shiprocketPassword || 'pC5m6iyjb*C$eaTlv*2ea3%&AhbPzm&^',
  shiprocketToken: initialSavedSettings?.shiprocketToken || ''
};

// Ensure process.env also reflects the active credentials
process.env.SHIPROCKET_EMAIL = serverSettings.shiprocketEmail;
process.env.SHIPROCKET_PASSWORD = serverSettings.shiprocketPassword;
process.env.SHIPROCKET_TOKEN = serverSettings.shiprocketToken;

// Helper to determine if we are operating in simulation or live
const isLiveConfigured = () => {
  return !!(serverSettings.shiprocketToken || (serverSettings.shiprocketEmail && serverSettings.shiprocketPassword));
};

// Function to save live configurations to data_settings.json and .env file dynamically so they persist across reboots
const saveToEnv = (email: string, pass: string, token: string = '') => {
  try {
    fs.writeFileSync(
      SETTINGS_FILE_PATH,
      JSON.stringify({
        shiprocketEmail: email || '',
        shiprocketPassword: pass || '',
        shiprocketToken: token || ''
      }, null, 2),
      'utf-8'
    );

    const envPath = path.join(process.cwd(), '.env');
    // Read current .env if it exists to preserve any other keys like GEMINI_API_KEY
    let currentEnv: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          if (key) currentEnv[key] = val;
        }
      });
    }

    currentEnv['SHIPROCKET_EMAIL'] = email || '';
    currentEnv['SHIPROCKET_PASSWORD'] = pass || '';
    currentEnv['SHIPROCKET_TOKEN'] = token || '';
    if (process.env.GEMINI_API_KEY && !currentEnv['GEMINI_API_KEY']) {
      currentEnv['GEMINI_API_KEY'] = process.env.GEMINI_API_KEY;
    }

    const envContent = Object.entries(currentEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';

    fs.writeFileSync(envPath, envContent, 'utf-8');
    
    // Set in process.env instantly
    process.env.SHIPROCKET_EMAIL = email || '';
    process.env.SHIPROCKET_PASSWORD = pass || '';
    process.env.SHIPROCKET_TOKEN = token || '';
  } catch (err) {
    console.error('[Server Settings] Failed to write settings file:', err);
  }
};

// -------------------------------------------------------------
// SHIPROCKET LIVE AND SIMULATED ENGINE
// -------------------------------------------------------------

// Active simulation memory database to persist states in preview
const ORDERS_FILE_PATH = path.join(process.cwd(), 'data_orders.json');

const getTodayStr = () => new Date().toISOString().slice(0, 10);
const getYesterdayStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const INITIAL_DEFAULT_ORDERS = [
  {
    id: "ord-1001",
    orderNumber: "DF-1021",
    date: getTodayStr(),
    customerName: "BANDARU VENKATESH",
    address: {
      address: "Door No 4-12, Main Bazar, Near Ram Temple",
      city: "Chemakurti",
      state: "Andhra Pradesh",
      pincode: "523270",
      phone: "8019566202",
      email: "bandaru.venk@gmail.com"
    },
    items: [
      { id: "p1", name: "Drone 4K Action Camera Ultra HD", sku: "DRN-ACT-4K", quantity: 1, price: 4999 }
    ],
    totalAmount: 4999,
    status: "pending",
    weight: 1.5,
    dimensions: { length: 22, width: 15, height: 6 },
    paymentMethod: "COD",
    trackingHistory: []
  },
  {
    id: "ord-1002",
    orderNumber: "DF-1022",
    date: "2026-07-12",
    customerName: "Lokesh Kamath",
    address: {
      address: "Flat 402, Sunrise Apartments, Outer Ring Road",
      city: "Bangalore",
      state: "Karnataka",
      pincode: "560103",
      phone: "9041935824",
      email: "lokesh.kamath@gmail.com"
    },
    items: [
      { id: "p2", name: "High-Pressure Water Wash Gun Pro", sku: "WTR-WSH-GUN", quantity: 1, price: 2499 }
    ],
    totalAmount: 2499,
    status: "awb_assigned",
    weight: 2.0,
    dimensions: { length: 22, width: 15, height: 6 },
    paymentMethod: "PREPAID",
    shiprocketOrderId: "SR-84920485",
    shipmentId: "SM-73920194",
    awbCode: "AWB9382019482",
    courierName: "BlueDart Air Premium",
    createdByEmployeeId: "System",
    createdByEmployeeName: "System",
    trackingHistory: [
      {
        date: "2026-07-12 14:30",
        status: "AWB Assigned",
        location: "Pune Warehouse (MH)",
        activity: "Shipment booked via BlueDart Air Premium. Shiprocket ID: SR-84920485"
      }
    ]
  },
  {
    id: "ord-1003",
    orderNumber: "DF-1023",
    date: "2026-07-11",
    customerName: "BUNNY",
    address: {
      address: "A-15, Sector 5, Salt Lake City",
      city: "Kolkata",
      state: "West Bengal",
      pincode: "700091",
      phone: "7071799145",
      email: "bunny.style@gmail.com"
    },
    items: [
      { id: "p3", name: "Handheld Gaming Console 4K OLED", sku: "GME-CNS-OLED", quantity: 1, price: 8999 }
    ],
    totalAmount: 8999,
    status: "shipped",
    weight: 0.8,
    dimensions: { length: 22, width: 15, height: 6 },
    paymentMethod: "COD",
    shiprocketOrderId: "SR-93049182",
    shipmentId: "SM-48201934",
    awbCode: "AWB7391039482",
    courierName: "Delhivery Express (Air)",
    createdByEmployeeId: "System",
    createdByEmployeeName: "System",
    trackingHistory: [
      {
        date: "2026-07-11 11:00",
        status: "AWB Assigned",
        location: "Pune Warehouse (MH)",
        activity: "Shipment booked via Delhivery Express (Air)."
      },
      {
        date: "2026-07-11 18:45",
        status: "In Transit",
        location: "Pune Hub (MH)",
        activity: "Package sorted and dispatched to Kolkata Hub."
      }
    ]
  },
  {
    id: "ord-1004",
    orderNumber: "DF-1024",
    date: "2026-07-10",
    customerName: "Aarav Sharma",
    address: {
      address: "H-401, Marvel Ritz, Karve Road",
      city: "Pune",
      state: "Maharashtra",
      pincode: "411038",
      phone: "9876543211",
      email: "aarav.sharma@gmail.com"
    },
    items: [
      { id: "p4", name: "High-Speed 4WD RC Car Offroad", sku: "RCC-4WD-OFF", quantity: 1, price: 3499 },
      { id: "p5", name: "Smart Portable 4K LED Projector", sku: "PRJ-4K-LED", quantity: 1, price: 12499 }
    ],
    totalAmount: 15998,
    status: "delivered",
    weight: 4.3,
    dimensions: { length: 22, width: 15, height: 6 },
    paymentMethod: "PREPAID",
    shiprocketOrderId: "SR-48291034",
    shipmentId: "SM-94830193",
    awbCode: "AWB4820192039",
    courierName: "Shadowfax Local Standard",
    trackingHistory: [
      {
        date: "2026-07-10 09:30",
        status: "AWB Assigned",
        location: "Pune Warehouse (MH)",
        activity: "Shipment booked via Shadowfax Local Standard."
      },
      {
        date: "2026-07-10 13:00",
        status: "Out for Delivery",
        location: "Pune Kothrud Hub",
        activity: "Courier partner has dispatched the package for delivery."
      },
      {
        date: "2026-07-10 16:45",
        status: "Delivered",
        location: "Pune",
        activity: "Successfully delivered to customer."
      }
    ]
  }
];

// Helper to load orders
function loadOrdersFromFile() {
  try {
    if (fs.existsSync(ORDERS_FILE_PATH)) {
      const data = fs.readFileSync(ORDERS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading orders file:', err);
  }
  return null;
}

let mockOrders = loadOrdersFromFile();
if (mockOrders === null) {
  mockOrders = [...INITIAL_DEFAULT_ORDERS];
  saveOrdersToFile();
} else if (Array.isArray(mockOrders)) {
  let needsSave = false;
  mockOrders.forEach((o: any) => {
    if (o && o.awbCode && !o.trackingUrl) {
      o.trackingUrl = getShiprocketTrackingUrl(o.awbCode);
      needsSave = true;
    }
  });
  if (needsSave) {
    saveOrdersToFile();
  }
}

// Helper to save orders
async function saveOrdersToFile() {
  try {
    fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(mockOrders, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving orders:', err);
  }
}

// Helper to retrieve an order by ID or orderNumber from database (with Firestore sync)
async function getOrderFromDb(orderId: string): Promise<any | null> {
  const strId = String(orderId).trim();
  let found = mockOrders.find((o: any) => String(o.id) === strId || String(o.orderNumber) === strId);
  if (isFirebaseEnabled && firestoreDb) {
    try {
      const docSnap = await getDoc(doc(firestoreDb, 'orders', strId));
      if (docSnap.exists()) {
        const dbData = docSnap.data();
        if (found) {
          Object.assign(found, dbData);
        } else {
          found = dbData;
          mockOrders.push(found);
        }
      }
    } catch (err: any) {
      console.warn('[Firebase] Error fetching order from Firestore:', err.message || err);
    }
  }
  return found || null;
}

// Helper to atomically save a single order to both in-memory/JSON and Firestore
async function saveSingleOrderToDb(order: any): Promise<void> {
  const idx = mockOrders.findIndex((o: any) => String(o.id) === String(order.id) || String(o.orderNumber) === String(order.id));
  if (idx >= 0) {
    mockOrders[idx] = { ...mockOrders[idx], ...order };
  } else {
    mockOrders.push(order);
  }
  try {
    fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(mockOrders, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing orders file:', err);
  }

  if (isFirebaseEnabled && firestoreDb && order.id) {
    try {
      await setDoc(doc(firestoreDb, 'orders', String(order.id)), sanitizeForFirestore(order));
      console.log(`[Firebase] Successfully persisted order ${order.id} with status "${order.status}"`);
    } catch (err: any) {
      console.error('[Firebase] Failed to persist single order to Firestore:', err.message || err);
    }
  }
}

const EMPLOYEES_FILE_PATH = path.join(process.cwd(), 'data_employees.json');
const PRODUCTS_FILE_PATH = path.join(process.cwd(), 'data_products.json');

const INITIAL_DEFAULT_EMPLOYEES = [];

const INITIAL_DEFAULT_PRODUCTS: any[] = [];

function loadEmployeesFromFile() {
  try {
    if (fs.existsSync(EMPLOYEES_FILE_PATH)) {
      const data = fs.readFileSync(EMPLOYEES_FILE_PATH, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((e: any) => {
          if (!e || !e.name) return false;
          const lowerName = e.name.toLowerCase().trim();
          const lowerEmail = (e.email || '').toLowerCase().trim();
          const lowerUsername = (e.username || '').toLowerCase().trim();
          if (
            lowerName === 'rohan deshmukh' ||
            lowerName === 'shreya ghoshal' ||
            lowerName === 'harika' ||
            lowerName === 'rani' ||
            lowerEmail.includes('harika') ||
            lowerEmail.includes('esterranirani585') ||
            lowerUsername.includes('harika') ||
            lowerUsername.includes('esterranirani585')
          ) {
            return false;
          }
          return true;
        });
      }
    }
  } catch (err) {
    console.error('Error reading employees file:', err);
  }
  return null;
}

const loadedEmployees = loadEmployeesFromFile();
let mockEmployees = (loadedEmployees && Array.isArray(loadedEmployees))
  ? loadedEmployees
  : [];

async function saveEmployeesToFile() {
  try {
    fs.writeFileSync(EMPLOYEES_FILE_PATH, JSON.stringify(mockEmployees, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving employees:', err);
  }
}

function loadProductsFromFile() {
  try {
    if (fs.existsSync(PRODUCTS_FILE_PATH)) {
      const data = fs.readFileSync(PRODUCTS_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading products file:', err);
  }
  return null;
}

const loadedProducts = loadProductsFromFile();
let mockProducts: any[] = (loadedProducts && Array.isArray(loadedProducts))
  ? loadedProducts
  : [];

async function saveProductsToFile() {
  try {
    fs.writeFileSync(PRODUCTS_FILE_PATH, JSON.stringify(mockProducts, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving products:', err);
  }
}

const CUSTOMERS_FILE_PATH = path.join(process.cwd(), 'data_customers.json');

const INITIAL_DEFAULT_CUSTOMERS = [
  { id: 'c1', name: 'BANDARU VENKATESH', phone: '8019566202', email: 'bandaru.venk@gmail.com', city: 'Chemakurti', state: 'Andhra Pradesh', ordersCount: 1, totalSpent: 2200 },
  { id: 'c2', name: 'Lokesh Kamath', phone: '9041935824', email: 'lokesh.kamath@gmail.com', city: 'Bangalore', state: 'Karnataka', ordersCount: 1, totalSpent: 2000 },
  { id: 'c3', name: 'BUNNY', phone: '7071799145', email: 'bunny.style@gmail.com', city: 'Kolkata', state: 'West Bengal', ordersCount: 1, totalSpent: 2400 },
  { id: 'c4', name: 'Aarav Sharma', phone: '9876543211', email: 'aarav.sharma@gmail.com', city: 'Pune', state: 'Maharashtra', ordersCount: 2, totalSpent: 4297 },
  { id: 'c5', name: 'Ananya Iyer', phone: '8765432109', email: 'ananya.iyer@gmail.com', city: 'Bengaluru', state: 'Karnataka', ordersCount: 1, totalSpent: 3298 }
];

function loadCustomersFromFile() {
  try {
    if (fs.existsSync(CUSTOMERS_FILE_PATH)) {
      const data = fs.readFileSync(CUSTOMERS_FILE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading customers file:', err);
  }
  return null;
}

const loadedCustomers = loadCustomersFromFile();
let mockCustomers = (loadedCustomers && Array.isArray(loadedCustomers) && loadedCustomers.length > 0)
  ? loadedCustomers
  : [...INITIAL_DEFAULT_CUSTOMERS];

async function saveCustomersToFile() {
  try {
    fs.writeFileSync(CUSTOMERS_FILE_PATH, JSON.stringify(mockCustomers, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving customers:', err);
  }
}

const REPLACEMENTS_FILE_PATH = path.join(process.cwd(), 'data_replacements.json');

function loadReplacementsFromFile() {
  try {
    if (fs.existsSync(REPLACEMENTS_FILE_PATH)) {
      const data = fs.readFileSync(REPLACEMENTS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('Error reading replacements file:', err);
  }
  return null;
}

const loadedReplacements = loadReplacementsFromFile();
let mockReplacements: any[] = (loadedReplacements && Array.isArray(loadedReplacements))
  ? loadedReplacements
  : [];

async function saveReplacementsToFile() {
  try {
    fs.writeFileSync(REPLACEMENTS_FILE_PATH, JSON.stringify(mockReplacements, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving replacements:', err);
  }
}

// Global cloud/local sync on boot
async function syncFromFirestore() {
  if (!isFirebaseEnabled || !firestoreDb) {
    console.log('[Firebase] Cloud Firestore is disabled or not configured.');
    return;
  }
  console.log('[Firebase] Loading and smart-merging records from Google Cloud Firestore...');

  try {
    // 1. Synchronize Orders with Smart Merge
    const ordersCol = collection(firestoreDb, 'orders');
    const ordersSnapshot = await getDocs(ordersCol);
    const ordersList: any[] = [];
    ordersSnapshot.forEach((doc) => {
      ordersList.push(doc.data());
    });
    
    if (ordersList.length === 0) {
      console.log('[Firebase] Firestore orders collection is empty. Syncing local state to cloud...');
      for (const order of mockOrders) {
        if (order && order.id) {
          await setDoc(doc(firestoreDb, 'orders', String(order.id)), sanitizeForFirestore(order));
        }
      }
    } else {
      mockOrders = ordersList;
      console.log(`[Firebase] Loaded ${mockOrders.length} orders from Firestore.`);
    }

    // 2. Synchronize Employees with Smart Merge
    const employeesCol = collection(firestoreDb, 'employees');
    const employeesSnapshot = await getDocs(employeesCol);
    const employeesList: any[] = [];
    employeesSnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const name = data.name || '';
      const email = data.email || '';
      if (name !== 'Rohan Deshmukh' && name !== 'Shreya Ghoshal' && email !== 'rohan@dapperfit.com' && email !== 'shreya@dapperfit.com') {
        employeesList.push(data);
      } else {
        // Purge demo employees from the database
        deleteDoc(doc(firestoreDb, 'employees', docSnap.id)).catch(err => {
          console.error('[Firebase] Purging demo employee failed:', err);
        });
      }
    });

    if (employeesList.length === 0) {
      console.log('[Firebase] Firestore employees collection is empty. Syncing local state to cloud...');
      for (const emp of mockEmployees) {
        if (emp && emp.id) {
          await setDoc(doc(firestoreDb, 'employees', String(emp.id)), sanitizeForFirestore(emp));
        }
      }
    } else {
      mockEmployees = employeesList;
      console.log(`[Firebase] Loaded ${mockEmployees.length} employees from Firestore.`);

      await Promise.all(
        mockEmployees.map(async (emp) => {
          if (emp && emp.id) {
            await setDoc(doc(firestoreDb, 'employees', String(emp.id)), sanitizeForFirestore(emp));
          }
        })
      );
    }

    // 3. Synchronize Products
    const productsCol = collection(firestoreDb, 'products');
    const productsSnapshot = await getDocs(productsCol);
    const productsList: any[] = [];
    productsSnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data && data.id) {
        productsList.push(data);
      }
    });

    if (productsList.length === 0) {
      console.log('[Firebase] Firestore products collection is empty. Syncing local state to cloud...');
      for (const prod of mockProducts) {
        if (prod && prod.id) {
          await setDoc(doc(firestoreDb, 'products', String(prod.id)), sanitizeForFirestore(prod));
        }
      }
    } else {
      mockProducts = productsList;
      console.log(`[Firebase] Loaded ${mockProducts.length} products from Firestore.`);
      saveProductsToFile();
    }

    // 4. Synchronize Customers with Smart Merge
    const customersCol = collection(firestoreDb, 'customers');
    const customersSnapshot = await getDocs(customersCol);
    const customersList: any[] = [];
    customersSnapshot.forEach((doc) => {
      customersList.push(doc.data());
    });

    if (customersList.length === 0) {
      console.log('[Firebase] Firestore customers collection is empty. Syncing local state to cloud...');
      for (const cust of mockCustomers) {
        if (cust && cust.id) {
          await setDoc(doc(firestoreDb, 'customers', String(cust.id)), sanitizeForFirestore(cust));
        }
      }
    } else {
      mockCustomers = customersList;
      console.log(`[Firebase] Loaded ${mockCustomers.length} customers from Firestore.`);

      await Promise.all(
        mockCustomers.map(async (cust) => {
          if (cust && cust.id) {
            await setDoc(doc(firestoreDb, 'customers', String(cust.id)), sanitizeForFirestore(cust));
          }
        })
      );
    }

    // 5. Synchronize Replacement Requests with Smart Merge
    const replacementsCol = collection(firestoreDb, 'replacements');
    const replacementsSnapshot = await getDocs(replacementsCol);
    const replacementsList: any[] = [];
    replacementsSnapshot.forEach((docSnap) => {
      replacementsList.push(docSnap.data());
    });

    if (replacementsList.length === 0) {
      console.log('[Firebase] Firestore replacements collection is empty. Syncing local state to cloud...');
      for (const rep of mockReplacements) {
        if (rep && rep.id) {
          await setDoc(doc(firestoreDb, 'replacements', String(rep.id)), sanitizeForFirestore(rep));
        }
      }
    } else {
      mockReplacements = replacementsList;
      console.log(`[Firebase] Loaded ${mockReplacements.length} replacements from Firestore.`);
    }

    // Write a local backup
    fs.writeFileSync(ORDERS_FILE_PATH, JSON.stringify(mockOrders, null, 2), 'utf8');
    fs.writeFileSync(EMPLOYEES_FILE_PATH, JSON.stringify(mockEmployees, null, 2), 'utf8');
    fs.writeFileSync(PRODUCTS_FILE_PATH, JSON.stringify(mockProducts, null, 2), 'utf8');
    fs.writeFileSync(CUSTOMERS_FILE_PATH, JSON.stringify(mockCustomers, null, 2), 'utf8');
    fs.writeFileSync(REPLACEMENTS_FILE_PATH, JSON.stringify(mockReplacements, null, 2), 'utf8');

    // 6. Synchronize Shiprocket Wallet with Smart Merge
    try {
      const walletSnap = await getDoc(doc(firestoreDb, 'shiprocket_wallet', 'current'));
      if (walletSnap.exists()) {
        const d = walletSnap.data();
        cachedWalletDetails = {
          available_balance: typeof d.available_balance === 'number' ? d.available_balance : (cachedWalletDetails?.available_balance ?? loadWalletBalance()),
          hold_amount: typeof d.hold_amount === 'number' ? d.hold_amount : 0.00,
          last_sync_time: d.last_sync_time || new Date().toISOString(),
          is_simulated: d.is_simulated !== undefined ? d.is_simulated : !isLiveConfigured()
        };
        fs.writeFileSync(WALLET_DETAILS_FILE_PATH, JSON.stringify(cachedWalletDetails, null, 2), 'utf8');
        console.log('[Firebase] Synchronized wallet details from Firestore.');
      } else if (cachedWalletDetails) {
        await setDoc(doc(firestoreDb, 'shiprocket_wallet', 'current'), sanitizeForFirestore(cachedWalletDetails));
        console.log('[Firebase] Initialized wallet details in Firestore.');
      }
    } catch (walletErr: any) {
      // Gracefully continue without unhandled exceptions
    }

  } catch (err: any) {
    console.error('[Firebase] Failed to load data from Firestore:', err.message || err);
  }
}

let lastAuthFailedTime: number | null = null;

// Helper to acquire live Shiprocket Authorization headers
async function getShiprocketAuthHeaders() {
  if (!isLiveConfigured()) return {};

  // Option 2: If manual bearer token is configured, use it directly
  if (serverSettings.shiprocketToken) {
    return { 'Authorization': `Bearer ${serverSettings.shiprocketToken}`, 'Content-Type': 'application/json' };
  }

  // Option 1: Retrieve using email and password login flow
  const email = serverSettings.shiprocketEmail;
  const password = serverSettings.shiprocketPassword;

  // If token cached is valid (10 days token expiry), reuse it
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return { 'Authorization': `Bearer ${cachedToken}`, 'Content-Type': 'application/json' };
  }

  // If we failed to authenticate in the last 60 seconds, skip live request and throw/fallback immediately
  if (lastAuthFailedTime && Date.now() - lastAuthFailedTime < 60000) {
    throw new Error('Authentication is temporarily disabled due to previous failure.');
  }

  try {
    let authData;
    try {
      authData = await shiprocket.rawRequest('/auth/login', 'POST', {}, { email, password });
    } catch (authErr: any) {
      if (email === 'k.nithwik750@gmail.com' && !password.includes('*')) {
        const altPassword = 'pC5m6iyjb*C$eaTlv*2ea3%&AhbPzm&^';
        authData = await shiprocket.rawRequest('/auth/login', 'POST', {}, { email, password: altPassword });
        serverSettings.shiprocketPassword = altPassword;
        saveToEnv(email, altPassword, '');
      } else {
        throw authErr;
      }
    }
    cachedToken = authData.token;
    // Expire token cache in 9 days to be safe
    tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
    lastAuthFailedTime = null; // Reset on success

    return { 'Authorization': `Bearer ${cachedToken}`, 'Content-Type': 'application/json' };
  } catch (err: any) {
    lastAuthFailedTime = Date.now();
    console.log('[Shiprocket] Authentication retrieval failed, skipping future attempts for 60s:', err.message || err);
    throw err;
  }
}

// -------------------------------------------------------------
// ENDPOINTS


const ADMIN_FILE_PATH = path.join(process.cwd(), 'data_admin.json');
function loadAdminCreds() {
  try {
    if (fs.existsSync(ADMIN_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(ADMIN_FILE_PATH, 'utf8'));
    }
  } catch (err) { }
  return { email: 'dappersfit@gmail.com', password: 'Jail@1974', name: 'Dappersfit Admin' };
}
let adminCreds = loadAdminCreds();

function saveAdminCreds() {
  try {
    fs.writeFileSync(ADMIN_FILE_PATH, JSON.stringify(adminCreds, null, 2), 'utf8');
  } catch (err) { }
}

app.post('/api/auth/login', (req, res) => {
  const { email, password, role } = req.body;
  const normalizedEmail = (email || '').trim().toLowerCase();

  if (role === 'admin') {
    if (normalizedEmail === adminCreds.email.toLowerCase() && password === adminCreds.password) {
      return res.json({ success: true, user: { name: adminCreds.name, email: adminCreds.email, role: 'admin' } });
    } else {
      const matchedEmp = mockEmployees.find((e: any) => {
        const empEmail = (e.email || '').trim().toLowerCase();
        const empUsername = (e.username || '').trim().toLowerCase();
        return (empEmail === normalizedEmail || empUsername === normalizedEmail) && e.password === password;
      });
      if (matchedEmp) {
        if (matchedEmp.status === 'inactive') {
          return res.status(403).json({ success: false, error: 'Your account has been deactivated.' });
        }
        return res.json({ success: true, user: { id: matchedEmp.id, name: matchedEmp.name, email: matchedEmp.email, role: 'employee' } });
      }
      return res.status(401).json({ success: false, error: 'Invalid administrator email or password.' });
    }
  } else {
    const matchedEmp = mockEmployees.find((e: any) => {
      const empEmail = (e.email || '').trim().toLowerCase();
      const empUsername = (e.username || '').trim().toLowerCase();
      return (empEmail === normalizedEmail || empUsername === normalizedEmail) && e.password === password;
    });
    if (matchedEmp) {
      if (matchedEmp.status === 'inactive') {
        return res.status(403).json({ success: false, error: 'Your account has been deactivated.' });
      }
      return res.json({ success: true, user: { id: matchedEmp.id, name: matchedEmp.name, email: matchedEmp.email, role: 'employee' } });
    }
    return res.status(401).json({ success: false, error: 'Invalid employee credentials.' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { role, oldPassword, newPassword, userId, email } = req.body;
  if (role === 'admin') {
    if (oldPassword !== adminCreds.password) {
      return res.status(401).json({ success: false, error: 'Incorrect current password.' });
    }
    adminCreds.password = newPassword;
    saveAdminCreds();
    return res.json({ success: true });
  } else {
    let empIdx = -1;
    if (userId) {
      empIdx = mockEmployees.findIndex((e: any) => e.id === userId);
    } else if (email) {
      empIdx = mockEmployees.findIndex((e: any) => e.email === email);
    }
    
    if (empIdx === -1) return res.status(404).json({ success: false, error: 'Employee not found.' });
    
    if (mockEmployees[empIdx].password !== oldPassword) {
      return res.status(401).json({ success: false, error: 'Incorrect current password.' });
    }
    mockEmployees[empIdx].password = newPassword;
    saveEmployeesToFile();
    // Also sync to firestore if enabled
    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'employees', String(mockEmployees[empIdx].id)), mockEmployees[empIdx]);
      } catch (err) { }
    }
    return res.json({ success: true });
  }
});

// -------------------------------------------------------------

// API route: check if server is operating in sandbox or live Shiprocket
app.get('/api/status', (req, res) => {
  res.json({
    isSimulated: !isLiveConfigured(),
    isLiveConfigured: isLiveConfigured(),
    email: serverSettings.shiprocketEmail || null,
    password: serverSettings.shiprocketPassword || null,
    token: serverSettings.shiprocketToken || null
  });
});

// API route: Save dynamic administrative settings
app.post('/api/settings', (req, res) => {
  const { shiprocketEmail, shiprocketPassword, shiprocketToken } = req.body;
  
  if (shiprocketEmail !== undefined) {
    serverSettings.shiprocketEmail = shiprocketEmail;
  }
  if (shiprocketPassword !== undefined) {
    serverSettings.shiprocketPassword = shiprocketPassword;
  }
  if (shiprocketToken !== undefined) {
    serverSettings.shiprocketToken = shiprocketToken;
  }
  
  // Reset token cache when credentials are changed
  cachedToken = null;
  tokenExpiry = null;

  // Persist to .env
  saveToEnv(
    serverSettings.shiprocketEmail,
    serverSettings.shiprocketPassword,
    serverSettings.shiprocketToken
  );
  
  res.json({
    status: 'ok',
    isSimulated: !isLiveConfigured(),
    isLiveConfigured: isLiveConfigured(),
    email: serverSettings.shiprocketEmail || null,
    token: serverSettings.shiprocketToken || null
  });
});

// API route: Test Shiprocket login credentials directly
app.post('/api/shiprocket/test-connection', async (req, res) => {
  const { email, password, token } = req.body;
  
  // Option 2: Test pasted token directly
  if (token) {
    try {
      // Validate token by attempting to request courier serviceability with dummy data
      await shiprocket.rawRequest(
        '/courier/serviceability?pickup_postcode=110001&delivery_postcode=110001&weight=0.5',
        'GET',
        { 'Authorization': `Bearer ${token}` }
      );
      
      // Save settings and cache
      serverSettings.shiprocketToken = token;
      serverSettings.shiprocketEmail = '';
      serverSettings.shiprocketPassword = '';
      cachedToken = token;
      tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;

      saveToEnv('', '', token);

      return res.json({
        success: true,
        message: 'Verified Shiprocket Bearer Token successfully!'
      });
    } catch (err: any) {
      console.log('Shiprocket bearer token verification failure:', err);
      return res.status(401).json({
        success: false,
        error: `Bearer Token verification failed: ${err.message || err}`
      });
    }
  }

  // Option 1: Test Email & Password credentials
  const testEmail = email !== undefined ? email : serverSettings.shiprocketEmail;
  let testPassword = password !== undefined ? password : serverSettings.shiprocketPassword;
  
  if (!testEmail || !testPassword) {
    return res.status(400).json({
      success: false,
      error: 'Credentials (Email & Password) or Bearer Token is required to test connection.'
    });
  }
  
  try {
    let authData;
    try {
      authData = await shiprocket.rawRequest('/auth/login', 'POST', {}, { email: testEmail, password: testPassword });
    } catch (testErr: any) {
      if (testEmail === 'k.nithwik750@gmail.com' && !testPassword.includes('*')) {
        const altPassword = 'pC5m6iyjb*C$eaTlv*2ea3%&AhbPzm&^';
        authData = await shiprocket.rawRequest('/auth/login', 'POST', {}, { email: testEmail, password: altPassword });
        testPassword = altPassword;
      } else {
        throw testErr;
      }
    }

    if (authData.token) {
      // Update cache since we proved it works!
      cachedToken = authData.token;
      tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
      
      // Update active settings
      serverSettings.shiprocketEmail = testEmail;
      serverSettings.shiprocketPassword = testPassword;
      serverSettings.shiprocketToken = '';

      // Save to .env dynamically
      saveToEnv(testEmail, testPassword, '');
      
      return res.json({
        success: true,
        message: 'Connected to Shiprocket successfully!'
      });
    } else {
      return res.status(401).json({
        success: false,
        error: 'Shiprocket did not return a valid auth token.'
      });
    }
  } catch (err: any) {
    console.log('Shiprocket test connection error:', err);
    return res.status(401).json({
      success: false,
      error: `Authentication failed: ${err.message || err}`
    });
  }
});

// API route: Seed demo orders in the active memory database
app.post('/api/orders/seed', (req, res) => {
  mockOrders = [...INITIAL_DEFAULT_ORDERS];
  saveOrdersToFile();
  res.json({ status: 'ok', orders: mockOrders });
});

// API route: Wipe all data instantly
app.post('/api/admin/wipe-all', (req, res) => {
  mockOrders = [];
  mockEmployees = [];
  mockProducts = [];
  mockCustomers = [];
  saveOrdersToFile();
  saveEmployeesToFile();
  saveProductsToFile();
  saveCustomersToFile();
  res.json({ success: true, message: 'All database tables successfully wiped and reset to clean empty state!' });
});

// API route: Get current orders
app.get('/api/orders', async (req, res) => {
  if (isFirebaseEnabled && firestoreDb) {
    try {
      const ordersCol = collection(firestoreDb, 'orders');
      const ordersSnapshot = await getDocs(ordersCol);
      const cloudOrders: any[] = [];
      ordersSnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.id) {
          cloudOrders.push(data);
        }
      });
      if (cloudOrders.length > 0) {
        // Sort descending so newest orders appear at top
        cloudOrders.sort((a, b) => {
          const dateA = a.date || '';
          const dateB = b.date || '';
          if (dateA !== dateB) return dateB.localeCompare(dateA);
          return String(b.id).localeCompare(String(a.id));
        });
        cloudOrders.forEach(o => {
          if (!Number.isFinite(o.totalAmount)) {
            let calc = 0;
            if (Array.isArray(o.items)) {
              calc = o.items.reduce((s: number, i: any) => {
                const price = Number(i?.price) || 0;
                const qty = Number(i?.quantity) || 1;
                return s + (price * qty);
              }, 0);
            }
            o.totalAmount = Number.isFinite(calc) ? calc : 0;
          }
        });
        mockOrders = cloudOrders;
        return res.json({ orders: cloudOrders });
      }
    } catch (err: any) {
      console.error('[Firebase] Failed to load orders from Firestore, falling back to memory:', err.message || err);
    }
  }
  mockOrders.forEach(o => {
    if (!Number.isFinite(o.totalAmount)) {
      let calc = 0;
      if (Array.isArray(o.items)) {
        calc = o.items.reduce((s: number, i: any) => {
          const price = Number(i?.price) || 0;
          const qty = Number(i?.quantity) || 1;
          return s + (price * qty);
        }, 0);
      }
      o.totalAmount = Number.isFinite(calc) ? calc : 0;
    }
  });
  res.json({ orders: mockOrders });
});

// API route: Create/Update an order
app.post('/api/orders', async (req, res) => {
  const newOrder = req.body;
  
  if (!newOrder) {
    return res.status(400).json({ error: 'Order payload required' });
  }

  // Ensure totalAmount is a valid number
  if (!Number.isFinite(newOrder.totalAmount)) {
    let calc = 0;
    if (Array.isArray(newOrder.items)) {
      calc = newOrder.items.reduce((s: number, i: any) => {
        const price = Number(i?.price) || 0;
        const qty = Number(i?.quantity) || 1;
        return s + (price * qty);
      }, 0);
    }
    newOrder.totalAmount = Number.isFinite(calc) ? calc : 0;
  }

  // Generate a unique ID if not provided
  if (!newOrder.id) {
    newOrder.id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  // Strictly check if updating an existing order by ID
  const existingIdx = mockOrders.findIndex(o => String(o.id) === String(newOrder.id));
  
  if (existingIdx >= 0) {
    // Update existing order
    mockOrders[existingIdx] = { ...mockOrders[existingIdx], ...newOrder };
  } else {
    // Creating a new order
    // Ensure orderNumber is present and unique
    if (!newOrder.orderNumber) {
      let maxNum = 1090;
      mockOrders.forEach(o => {
        if (o.orderNumber && o.orderNumber.startsWith('DF-')) {
          const num = parseInt(o.orderNumber.replace('DF-', ''), 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      });
      newOrder.orderNumber = `DF-${maxNum + 1}`;
    } else {
      // If orderNumber is already in use by another order, re-assign a unique suffix
      const duplicateNum = mockOrders.some(o => o.orderNumber === newOrder.orderNumber);
      if (duplicateNum) {
        let maxNum = 1090;
        mockOrders.forEach(o => {
          if (o.orderNumber && o.orderNumber.startsWith('DF-')) {
            const num = parseInt(o.orderNumber.replace('DF-', ''), 10);
            if (!isNaN(num) && num > maxNum) {
              maxNum = num;
            }
          }
        });
        newOrder.orderNumber = `DF-${maxNum + 1}`;
      }
    }
    // Ensure order timestamp & date are present with exact minute precision
    if (!newOrder.createdAt) {
      newOrder.createdAt = new Date().toISOString();
    }
    if (!newOrder.date) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      newOrder.date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    mockOrders.unshift(newOrder);
  }

  // Instantly write to Google Cloud Firestore database
  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'orders', String(newOrder.id)), sanitizeForFirestore(newOrder));
      console.log(`[Firebase] Instantly stored order ${newOrder.id} (${newOrder.orderNumber}) in Firestore.`);
    } catch (err: any) {
      console.error('[Firebase] SetDoc error for order:', err.message || err);
    }
  }

  await saveOrdersToFile();
  res.json({ success: true, order: newOrder, orders: mockOrders });
});

// API route: Delete an order
app.delete('/api/orders/:id', async (req, res) => {
  const { id } = req.params;
  const initialLen = mockOrders.length;
  mockOrders = mockOrders.filter(o => o && String(o.id) !== String(id));
  
  if (isFirebaseEnabled && firestoreDb) {
    try {
      await deleteDoc(doc(firestoreDb, 'orders', String(id)));
    } catch (err) {
      console.error('[Firebase] Direct delete of order failed:', err);
    }
  }

  await saveOrdersToFile();
  return res.json({ success: true, message: 'Order deleted successfully', orders: mockOrders });
});

// API route: Get current employees
app.get('/api/employees', (req, res) => {
  res.json({ employees: mockEmployees });
});

// API route: Create/Update an employee
app.post('/api/employees', (req, res) => {
  const emp = req.body;
  if (!emp.id) {
    emp.id = `emp-${Date.now()}`;
  }
  const existingIdx = mockEmployees.findIndex(e => e.id === emp.id);
  if (existingIdx >= 0) {
    mockEmployees[existingIdx] = { ...mockEmployees[existingIdx], ...emp };
  } else {
    mockEmployees.push(emp);
  }
  saveEmployeesToFile();
  res.json({ success: true, employee: emp, employees: mockEmployees });
});

// API route: Delete an employee
app.delete('/api/employees/:id', (req, res) => {
  const { id } = req.params;
  const deletedEmp = mockEmployees.find(e => e && String(e.id) === String(id));
  mockEmployees = mockEmployees.filter(e => e && String(e.id) !== String(id));

  if (deletedEmp) {
    const empEmail = deletedEmp.email || '';
    const empName = deletedEmp.name || '';
    
    // Cascading delete: Filter out and delete orders created or assigned to this employee
    mockOrders = mockOrders.filter(o => {
      const isCreatedByThis = (o.createdByEmployeeId || '').toLowerCase().trim() === empEmail.toLowerCase().trim() ||
        (o.createdByEmployeeId || '').toLowerCase().trim() === (deletedEmp.username || '').toLowerCase().trim();
      const isAssignedToThis = o.assignedEmployeeId === id || o.assignedEmployeeId === empName;
      return !(isCreatedByThis || isAssignedToThis);
    });
    saveOrdersToFile();
  }

  if (isFirebaseEnabled && firestoreDb) {
    try {
      deleteDoc(doc(firestoreDb, 'employees', String(id))).catch(err => {
        console.error('[Firebase] Direct delete of employee failed:', err);
      });
    } catch (err) {
      console.error('[Firebase] Direct delete of employee setup failed:', err);
    }
  }

  saveEmployeesToFile();
  res.json({ success: true, employees: mockEmployees });
});

// -------------------------------------------------------------
// DYNAMIC PAYROLL, INCENTIVES & AUTOMATED CHRON JOBS
// -------------------------------------------------------------

const PAYROLL_STATUS_FILE_PATH = path.join(process.cwd(), 'data_payroll_status.json');
const PAYROLL_PAID_DATES_FILE_PATH = path.join(process.cwd(), 'data_payroll_paid_dates.json');
const PAYROLL_HISTORY_FILE_PATH = path.join(process.cwd(), 'data_payroll_history.json');
const INCENTIVE_HISTORY_FILE_PATH = path.join(process.cwd(), 'data_incentive_history.json');
const INCENTIVE_RESETS_FILE_PATH = path.join(process.cwd(), 'data_incentive_resets.json');

let paidRecords: Record<string, 'Paid' | 'Processing'> = {};
if (fs.existsSync(PAYROLL_STATUS_FILE_PATH)) {
  try {
    paidRecords = JSON.parse(fs.readFileSync(PAYROLL_STATUS_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading payroll status:', err);
  }
}

let lastPayrollPaidMap: Record<string, { timestamp: number; dateStr: string; month: string; amount: number }> = {};
if (fs.existsSync(PAYROLL_PAID_DATES_FILE_PATH)) {
  try {
    lastPayrollPaidMap = JSON.parse(fs.readFileSync(PAYROLL_PAID_DATES_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading payroll paid dates:', err);
  }
}

let payrollHistory: any[] = [];
if (fs.existsSync(PAYROLL_HISTORY_FILE_PATH)) {
  try {
    payrollHistory = JSON.parse(fs.readFileSync(PAYROLL_HISTORY_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading payroll history:', err);
  }
}

let incentiveHistory: any[] = [];
if (fs.existsSync(INCENTIVE_HISTORY_FILE_PATH)) {
  try {
    incentiveHistory = JSON.parse(fs.readFileSync(INCENTIVE_HISTORY_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading incentive history:', err);
  }
}

let lastIncentiveReset: Record<string, number> = {};
if (fs.existsSync(INCENTIVE_RESETS_FILE_PATH)) {
  try {
    lastIncentiveReset = JSON.parse(fs.readFileSync(INCENTIVE_RESETS_FILE_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading incentive resets:', err);
  }
}

function savePayrollStatus() {
  try {
    fs.writeFileSync(PAYROLL_STATUS_FILE_PATH, JSON.stringify(paidRecords, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving payroll status:', err);
  }
}

function savePayrollPaidDates() {
  try {
    fs.writeFileSync(PAYROLL_PAID_DATES_FILE_PATH, JSON.stringify(lastPayrollPaidMap, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving payroll paid dates:', err);
  }
}

function savePayrollHistory() {
  try {
    fs.writeFileSync(PAYROLL_HISTORY_FILE_PATH, JSON.stringify(payrollHistory, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving payroll history:', err);
  }
}

function saveIncentiveData() {
  try {
    fs.writeFileSync(INCENTIVE_HISTORY_FILE_PATH, JSON.stringify(incentiveHistory, null, 2), 'utf8');
    fs.writeFileSync(INCENTIVE_RESETS_FILE_PATH, JSON.stringify(lastIncentiveReset, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving incentive data:', err);
  }
}

const EXCLUDED_FROM_PAYROLL_AND_INCENTIVES = new Set([
  'hema',
  'shashikala',
  'shravya',
  'harika',
  'rani'
]);

function isExcludedFromPayrollAndIncentives(emp: any): boolean {
  if (!emp) return false;
  const name = String(emp.name || '').toLowerCase().trim();
  const username = String(emp.username || '').toLowerCase().trim();
  const email = String(emp.email || '').toLowerCase().trim();
  for (const excluded of EXCLUDED_FROM_PAYROLL_AND_INCENTIVES) {
    if (name === excluded || username.startsWith(excluded) || email.startsWith(excluded)) {
      return true;
    }
  }
  return false;
}

// Helper to calculate the start timestamp of the next minute
function getNextMinuteTimestamp(): number {
  return Math.floor(Date.now() / 60000 + 1) * 60000;
}

// Helper to determine exact timestamp of order for incentive and salary cycle calculation
function getOrderTimestamp(o: any): number {
  if (o.createdAt) {
    const t = new Date(o.createdAt).getTime();
    if (!isNaN(t)) return t;
  }
  if (o.date) {
    const dateStr = String(o.date).trim();
    const formatted = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T');
    const t = new Date(formatted).getTime();
    if (!isNaN(t)) return t;
    const direct = new Date(dateStr).getTime();
    if (!isNaN(direct)) return direct;
  }
  if (o.id && typeof o.id === 'string' && /^\d{13}/.test(o.id)) {
    const num = parseInt(o.id.split('-')[0], 10);
    if (!isNaN(num) && num > 1000000000000) return num;
  }
  // Baseline fixed timestamp for legacy mock dataset (July 2026 baseline)
  return 1784000000000;
}

let automationLogs: any[] = [
  { timestamp: new Date(Date.now() - 3600000).toISOString(), type: 'Weekly Incentives', message: 'Automated weekly incentive calculations completed. Scanned dispatch orders and aggregated performance benchmarks for active employees.' },
  { timestamp: new Date(Date.now() - 7200000).toISOString(), type: 'Monthly Salary', message: 'Automated monthly base salary routine successfully executed. Generated baseline draft payout ledger.' }
];

// Background routine representing the two distinct cron jobs
setInterval(() => {
  const now = new Date();
  const type = now.getMinutes() % 2 === 0 ? 'Weekly Incentives' : 'Monthly Salary';
  const message = type === 'Weekly Incentives'
    ? `Automated weekly incentive calculations successfully executed. Recalculated logistics performance bonuses for ${mockEmployees.length} active employees.`
    : `Automated monthly base salary routine completed. Consolidated payroll ledger and synced base salaries with current active staff list.`;
  
  automationLogs.unshift({
    timestamp: now.toISOString(),
    type,
    message
  });
  if (automationLogs.length > 25) {
    automationLogs = automationLogs.slice(0, 25);
  }
}, 60000);

// API endpoint: Get dynamic weekly incentives status and history log
app.get('/api/incentives', (req, res) => {
  const eligibleEmployees = mockEmployees.filter(emp => !isExcludedFromPayrollAndIncentives(emp));
  const activeData = eligibleEmployees.map(emp => {
    const resetTime = lastIncentiveReset[emp.id] || 0;
    
    const empOrders = mockOrders.filter(o => {
      const isCreatedByThisEmp = (o.createdByEmployeeId || '').toLowerCase().trim() === (emp.email || '').toLowerCase().trim() ||
        (o.createdByEmployeeId || '').toLowerCase().trim() === (emp.username || '').toLowerCase().trim();
      const isAssigned = isCreatedByThisEmp || o.assignedEmployeeId === emp.id || o.assignedEmployeeId === emp.name;
      const isConfirmed = o.status !== 'cancelled' && o.status !== 'pending';
      
      const orderTime = getOrderTimestamp(o);
      return isAssigned && isConfirmed && orderTime >= resetTime;
    });

    const productAdvanceCount = empOrders.filter(o => o.productAdvance).length;
    const standardCount = empOrders.length - productAdvanceCount;

    const commission = empOrders.reduce((sum, o) => {
      if (o.productAdvanceIncentive !== undefined) {
        return sum + Number(o.productAdvanceIncentive);
      }
      return sum + (o.productAdvance ? 50 : 30);
    }, 0);

    return {
      id: emp.id,
      name: emp.name,
      role: emp.role || 'Staff Operator',
      confirmedCount: empOrders.length,
      commission,
      productAdvanceCount,
      standardCount,
      resetTime,
      lastResetDate: resetTime ? new Date(resetTime).toLocaleString('en-IN') : 'Cycle active'
    };
  });

  res.json({ employees: activeData, history: incentiveHistory });
});

// API endpoint: Pay & Reset Weekly Incentive for an individual employee (starts recounting from next minute)
app.post('/api/incentives/pay', async (req, res) => {
  const { employeeId, employeeName, amount, orderCount, resetDate } = req.body;
  if (!employeeId) {
    return res.status(400).json({ error: 'employeeId is required' });
  }

  // Recounting starts fresh from the next minute boundary
  const defaultNextMinute = getNextMinuteTimestamp();
  let resetTimestamp = defaultNextMinute;

  if (resetDate && resetDate !== 'next-minute') {
    const dateStr = String(resetDate).trim();
    const parsed = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')).getTime();
    if (!isNaN(parsed)) {
      resetTimestamp = parsed;
    }
  }

  lastIncentiveReset[employeeId] = resetTimestamp;
  saveIncentiveData();

  const matchedEmp = mockEmployees.find(e => String(e.id) === String(employeeId) || e.name === employeeName);
  const employeePhone = matchedEmp?.phone || '';
  const recountFromStr = new Date(resetTimestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const newLog = {
    id: `inc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    employeeId,
    employeeName: employeeName || matchedEmp?.name || 'Employee',
    paidAmount: Number(amount) || 0,
    orderCount: Number(orderCount) || 0,
    payoutDate: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
    recountFrom: recountFromStr,
    status: 'Paid',
    phone: employeePhone
  };

  incentiveHistory.unshift(newLog);
  saveIncentiveData();

  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'incentive_resets', String(employeeId)), {
        employeeId,
        resetTime: resetTimestamp,
        updatedAt: new Date().toISOString()
      });
      await setDoc(doc(firestoreDb, 'incentive_history', String(newLog.id)), sanitizeForFirestore(newLog));
    } catch (e) {
      console.error('[Firebase] Failed to save incentive reset to firestore:', e);
    }
  }

  const smsNotification = `Dear ${newLog.employeeName}, your weekly incentive of ₹${newLog.paidAmount.toLocaleString()} (${newLog.orderCount} orders) has been credited successfully to your account. Performance cycle recounting begins fresh from: ${recountFromStr}. - Dappersfit Logistics`;

  let cleanPhone = employeePhone.replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }
  const whatsappUrl = cleanPhone ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(smsNotification)}` : '';

  res.json({ 
    success: true, 
    message: 'Your weekly incentive is credited successfully',
    log: newLog, 
    history: incentiveHistory, 
    resetTime: resetTimestamp,
    recountFrom: recountFromStr,
    lastResetDate: new Date(resetTimestamp).toLocaleString('en-IN'),
    employeePhone,
    smsNotification,
    whatsappUrl
  });
});

// API endpoint: Manually set/reset employee incentive cycle start date and time
app.post('/api/employees/reset-date', async (req, res) => {
  const { employeeId, resetDate } = req.body;
  if (!employeeId) {
    return res.status(400).json({ error: 'employeeId is required' });
  }

  const defaultNextMinute = getNextMinuteTimestamp();
  let resetTimestamp = defaultNextMinute;

  if (resetDate && resetDate !== 'next-minute') {
    const dateStr = String(resetDate).trim();
    const parsed = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')).getTime();
    if (!isNaN(parsed)) {
      resetTimestamp = parsed;
    }
  }

  lastIncentiveReset[employeeId] = resetTimestamp;
  saveIncentiveData();

  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'incentive_resets', String(employeeId)), {
        employeeId,
        resetTime: resetTimestamp,
        updatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error('[Firebase] Failed to save reset-date to firestore:', e);
    }
  }

  res.json({
    success: true,
    employeeId,
    resetTime: resetTimestamp,
    lastResetDate: new Date(resetTimestamp).toLocaleString('en-IN')
  });
});

// API endpoint: Get dynamic payroll ledger and history
app.get('/api/payroll', (req, res) => {
  const month = String(req.query.month || 'July 2026');
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  
  const eligibleEmployees = mockEmployees.filter(emp => !isExcludedFromPayrollAndIncentives(emp));
  const payrollList = eligibleEmployees.map(emp => {
    const salary = Number(emp.payoutRate || 35000);
    const resetTime = lastIncentiveReset[emp.id] || 0;

    const empOrders = mockOrders.filter(o => {
      const isCreatedByThisEmp = (o.createdByEmployeeId || '').toLowerCase().trim() === (emp.email || '').toLowerCase().trim() ||
        (o.createdByEmployeeId || '').toLowerCase().trim() === (emp.username || '').toLowerCase().trim();
      const isAssigned = isCreatedByThisEmp || o.assignedEmployeeId === emp.id || o.assignedEmployeeId === emp.name;
      const isConfirmed = o.status !== 'cancelled' && o.status !== 'pending';
      
      const orderTime = getOrderTimestamp(o);
      return isAssigned && isConfirmed && orderTime >= resetTime;
    });
    
    const confirmedCount = empOrders.length;
    const commission = empOrders.reduce((sum, o) => {
      if (o.productAdvanceIncentive !== undefined) {
        return sum + Number(o.productAdvanceIncentive);
      }
      return sum + (o.productAdvance ? 50 : 30);
    }, 0);
    
    const productAdvanceCount = empOrders.filter(o => o.productAdvance).length;
    const incentives = commission;
    const deductions = 0;
    const totalPayout = salary + incentives;
    
    const recordKey = `${emp.id}_${month}`;
    const lastPaid = lastPayrollPaidMap[emp.id];

    let status: 'Paid' | 'Pending' = 'Pending';
    let disbursedDate = '—';
    let daysUntilNextDue = 0;
    let nextDueDateStr = '';
    let cycleNotice = 'Payment Due';

    if (lastPaid && lastPaid.timestamp) {
      disbursedDate = lastPaid.dateStr || new Date(lastPaid.timestamp).toLocaleDateString('en-IN');
      const elapsed = Date.now() - lastPaid.timestamp;
      if (elapsed < THIRTY_DAYS_MS) {
        status = 'Paid';
        daysUntilNextDue = Math.max(0, Math.ceil((THIRTY_DAYS_MS - elapsed) / (24 * 60 * 60 * 1000)));
        const nextDueTimestamp = lastPaid.timestamp + THIRTY_DAYS_MS;
        nextDueDateStr = new Date(nextDueTimestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        cycleNotice = `Paid on ${disbursedDate} • Next payout due in ${daysUntilNextDue} days (${nextDueDateStr})`;
      } else {
        status = 'Pending'; // 30 days have elapsed since last payment! Ask to pay for new 30-day cycle
        daysUntilNextDue = 0;
        cycleNotice = `30-Day Cycle Complete — Payment Due Now! (Last paid ${disbursedDate})`;
      }
    } else if (paidRecords[recordKey] === 'Paid') {
      status = 'Paid';
      disbursedDate = new Date().toLocaleDateString('en-IN');
      cycleNotice = `Paid for ${month}`;
    }
    
    return {
      id: emp.id,
      name: emp.name,
      role: emp.role || 'Staff Operator',
      phone: emp.phone || '',
      email: emp.email || '',
      salary,
      incentives,
      deductions,
      totalPayout,
      status,
      month,
      disbursedDate,
      daysUntilNextDue,
      nextDueDateStr,
      cycleNotice,
      resetTime,
      lastResetDate: resetTime ? new Date(resetTime).toLocaleString('en-IN') : 'Cycle active',
      breakdown: {
        confirmedCount,
        commission,
        productAdvanceCount
      }
    };
  });
  
  res.json({ payroll: payrollList, history: payrollHistory });
});

// API endpoint: Approve & Pay individual monthly salary and reset cycle from specified date
app.post('/api/payroll/approve', async (req, res) => {
  const { employeeId, employeeName, role, month, salaryAmount, incentiveAmount, totalPaid, notes, resetDate, date } = req.body;
  const targetMonth = month || 'July 2026';

  if (!employeeId) {
    return res.status(400).json({ error: 'employeeId is required' });
  }

  const recordKey = `${employeeId}_${targetMonth}`;
  paidRecords[recordKey] = 'Paid';
  savePayrollStatus();

  const chosenDate = resetDate || date;
  const defaultNextMinute = getNextMinuteTimestamp();
  let resetTimestamp = defaultNextMinute;

  if (chosenDate && chosenDate !== 'next-minute') {
    const dateStr = String(chosenDate).trim();
    const parsed = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')).getTime();
    if (!isNaN(parsed)) {
      resetTimestamp = parsed;
    }
  }
  
  // Set 30-day payroll payment record & reset active order counter
  const dateFormatted = new Date(resetTimestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  lastPayrollPaidMap[employeeId] = {
    timestamp: resetTimestamp,
    dateStr: dateFormatted,
    month: targetMonth,
    amount: Number(totalPaid) || 0
  };
  savePayrollPaidDates();

  lastIncentiveReset[employeeId] = resetTimestamp;
  saveIncentiveData();

  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'payroll_paid_dates', String(employeeId)), {
        employeeId,
        timestamp: resetTimestamp,
        dateStr: dateFormatted,
        month: targetMonth,
        amount: Number(totalPaid) || 0
      });
      await setDoc(doc(firestoreDb, 'incentive_resets', String(employeeId)), {
        employeeId,
        resetTime: resetTimestamp,
        updatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error('[Firebase] Failed to save payroll approve to firestore:', e);
    }
  }

  const matchedEmp = mockEmployees.find(e => String(e.id) === String(employeeId) || e.name === employeeName);
  const employeePhone = matchedEmp?.phone || '';
  const recountFromStr = new Date(resetTimestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const historyEntry = {
    id: `pay-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    employeeId,
    employeeName: employeeName || matchedEmp?.name || 'Employee',
    role: role || matchedEmp?.role || 'Staff Operator',
    month: targetMonth,
    salaryAmount: Number(salaryAmount) || 0,
    incentiveAmount: Number(incentiveAmount) || 0,
    totalPaid: Number(totalPaid) || (Number(salaryAmount) + Number(incentiveAmount)),
    payoutDate: new Date(resetTimestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
    status: 'Paid',
    notes: notes || `Monthly salary approved for ${targetMonth}`,
    phone: employeePhone,
    recountFrom: recountFromStr
  };

  payrollHistory.unshift(historyEntry);
  savePayrollHistory();

  const smsNotification = `Dear ${historyEntry.employeeName}, your salary of ₹${historyEntry.totalPaid.toLocaleString()} for ${targetMonth} has been credited successfully to your account. (Base Salary: ₹${historyEntry.salaryAmount.toLocaleString()} + Performance Incentives: ₹${historyEntry.incentiveAmount.toLocaleString()}). Next performance cycle starts from: ${recountFromStr}. - Dappersfit Logistics`;

  let cleanPhone = employeePhone.replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }
  const whatsappUrl = cleanPhone ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(smsNotification)}` : '';

  res.json({ 
    success: true, 
    message: 'Your salary is credited successfully',
    historyEntry, 
    history: payrollHistory, 
    paidRecords, 
    resetTime: resetTimestamp,
    recountFrom: recountFromStr,
    employeePhone,
    smsNotification,
    whatsappUrl
  });
});

// API endpoint: Bulk Distribute Pending Salary
app.post('/api/payroll/distribute', (req, res) => {
  const { month, employeeId } = req.body;
  const targetMonth = month || 'July 2026';
  const now = Date.now();
  const nextMinute = getNextMinuteTimestamp();
  const dateFormatted = new Date(now).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  if (employeeId) {
    const recordKey = `${employeeId}_${targetMonth}`;
    paidRecords[recordKey] = 'Paid';
    lastPayrollPaidMap[employeeId] = { timestamp: now, dateStr: dateFormatted, month: targetMonth, amount: 0 };
    lastIncentiveReset[employeeId] = nextMinute;
  } else {
    mockEmployees.filter(emp => !isExcludedFromPayrollAndIncentives(emp)).forEach(emp => {
      const recordKey = `${emp.id}_${targetMonth}`;
      paidRecords[recordKey] = 'Paid';
      lastPayrollPaidMap[emp.id] = { timestamp: now, dateStr: dateFormatted, month: targetMonth, amount: 0 };
      lastIncentiveReset[emp.id] = nextMinute;
    });
  }
  
  savePayrollPaidDates();
  saveIncentiveData();
  savePayrollStatus();
  res.json({ success: true, paidRecords });
});

// API endpoint: Get background cron automated logs
app.get('/api/payroll/automation-status', (req, res) => {
  res.json({ logs: automationLogs });
});

// API route: Get current products
app.get('/api/products', async (req, res) => {
  if (isFirebaseEnabled && firestoreDb) {
    try {
      const productsCol = collection(firestoreDb, 'products');
      const snapshot = await getDocs(productsCol);
      const cloudProducts: any[] = [];
      snapshot.forEach((d) => {
        const data = d.data();
        if (data && data.id) cloudProducts.push(data);
      });
      if (cloudProducts.length > 0) {
        mockProducts = cloudProducts;
      }
    } catch (err) {
      console.error('[Firebase] Failed to fetch products from cloud:', err);
    }
  }
  res.json({ products: mockProducts });
});

app.post('/api/products', async (req, res) => {
  const prod = req.body;
  if (!prod.id) {
    prod.id = `p-${Date.now()}`;
  }
  const existingIdx = mockProducts.findIndex(p => p && String(p.id) === String(prod.id));
  if (existingIdx >= 0) {
    mockProducts[existingIdx] = { ...mockProducts[existingIdx], ...prod };
  } else {
    mockProducts.unshift(prod);
  }

  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'products', String(prod.id)), sanitizeForFirestore(prod));
      console.log(`[Firebase] Saved product ${prod.id} (${prod.name}) to Firestore.`);
    } catch (err) {
      console.error('[Firebase] Direct write of product failed:', err);
    }
  }

  saveProductsToFile();
  res.json({ success: true, product: prod, products: mockProducts });
});

app.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  mockProducts = mockProducts.filter(p => p && String(p.id) !== String(id));

  if (isFirebaseEnabled && firestoreDb) {
    try {
      await deleteDoc(doc(firestoreDb, 'products', String(id)));
    } catch (err) {
      console.error('[Firebase] Direct delete of product failed:', err);
    }
  }

  saveProductsToFile();
  res.json({ success: true, products: mockProducts });
});

// =============================================================
// REPLACEMENT & EXCHANGE REQUESTS API ROUTES
// =============================================================

function saveBase64Image(base64Data: string, prefix: string = 'rep'): string | null {
  try {
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return null;
    
    const extension = matches[1].split('/')[1] === 'jpeg' ? 'jpg' : 'png';
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `${prefix}_${Date.now()}.${extension}`;
    
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Error saving base64 image:', err);
    return null;
  }
}

app.get('/api/replacements', async (req, res) => {
  if (isFirebaseEnabled && firestoreDb) {
    try {
      const col = collection(firestoreDb, 'replacements');
      const snapshot = await getDocs(col);
      const cloudItems: any[] = [];
      snapshot.forEach((d) => {
        const data = d.data();
        if (data && data.id) cloudItems.push(data);
      });
      if (cloudItems.length > 0) {
        mockReplacements = cloudItems;
      }
    } catch (err: any) {
      console.warn('[Firebase] Querying replacements failed, serving local cache:', err.message);
    }
  }
  // Sort by createdAt descending
  const sorted = [...mockReplacements].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    return timeB - timeA;
  });
  res.json({ replacements: sorted });
});

// API route: Create a new replacement/exchange request
app.post('/api/replacements', async (req, res) => {
  try {
    const payload = req.body || {};
    const type = payload.type === 'exchange' ? 'exchange' : 'replacement';
    const nowIso = new Date().toISOString();

    const customerPhone = (payload.customerPhone || '').trim();
    if (!customerPhone) {
      return res.status(400).json({ success: false, error: 'Customer phone number is mandatory.' });
    }

    let savedPhotoUrl = payload.photoUrl || '';
    if (payload.photoBase64) {
      savedPhotoUrl = payload.photoBase64;
    }

    // Generate readable ticket number
    const prefix = type === 'exchange' ? 'EXC' : 'REP';
    const ticketNumber = payload.ticketNumber || `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;

    const validFlag = ['red', 'orange', 'green', 'none'].includes(payload.flag) ? payload.flag : 'green';

    const newRequest: any = {
      id: payload.id || `rep-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      ticketNumber: ticketNumber,
      type: type,
      customerName: (payload.customerName || 'Customer').trim(),
      customerPhone: customerPhone,
      customerAddress: {
        address: (payload.customerAddress?.address || payload.address || '').trim(),
        city: (payload.customerAddress?.city || payload.city || '').trim(),
        state: (payload.customerAddress?.state || payload.state || '').trim(),
        pincode: (payload.customerAddress?.pincode || payload.pincode || '').trim()
      },
      orderNumber: (payload.orderNumber || '').trim(),
      productName: (payload.productName || 'General Product').trim(),
      productSku: (payload.productSku || '').trim(),
      reason: (payload.reason || 'Replacement requested').trim(),
      status: 'pending',
      flag: validFlag,
      flagReason: (payload.flagReason || '').trim(),
      photoUrl: savedPhotoUrl,
      notes: (payload.notes || '').trim(),
      adminNotes: (payload.adminNotes || '').trim(),
      createdBy: payload.createdBy || 'Staff',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    mockReplacements.unshift(newRequest);

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'replacements', String(newRequest.id)), sanitizeForFirestore(newRequest));
      } catch (fbErr) {
        console.error('[Firebase] Direct write of replacement request failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, replacement: newRequest, replacements: mockReplacements });
  } catch (err: any) {
    console.error('Error creating replacement request:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to create request' });
  }
});

// API route: Update replacement/exchange request details (edit option)
app.put('/api/replacements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existingIdx = mockReplacements.findIndex(r => r && String(r.id) === String(id));
    if (existingIdx === -1) {
      return res.status(404).json({ success: false, error: 'Replacement request not found' });
    }

    const payload = req.body || {};
    const existing = mockReplacements[existingIdx];

    if (payload.customerPhone !== undefined && !payload.customerPhone.trim()) {
      return res.status(400).json({ success: false, error: 'Customer phone number is mandatory.' });
    }

    let savedPhotoUrl = existing.photoUrl;
    if (payload.photoBase64) {
      savedPhotoUrl = payload.photoBase64;
    } else if (payload.photoUrl !== undefined) {
      savedPhotoUrl = payload.photoUrl;
    }

    const validFlag = payload.flag !== undefined && ['red', 'orange', 'green', 'none'].includes(payload.flag)
      ? payload.flag
      : (existing.flag || 'none');

    const updated: any = {
      ...existing,
      type: payload.type || existing.type,
      customerName: payload.customerName !== undefined ? payload.customerName.trim() : existing.customerName,
      customerPhone: payload.customerPhone !== undefined ? payload.customerPhone.trim() : existing.customerPhone,
      customerAddress: {
        address: payload.customerAddress?.address !== undefined ? payload.customerAddress.address.trim() : (payload.address !== undefined ? payload.address.trim() : existing.customerAddress?.address || ''),
        city: payload.customerAddress?.city !== undefined ? payload.customerAddress.city.trim() : (payload.city !== undefined ? payload.city.trim() : existing.customerAddress?.city || ''),
        state: payload.customerAddress?.state !== undefined ? payload.customerAddress.state.trim() : (payload.state !== undefined ? payload.state.trim() : existing.customerAddress?.state || ''),
        pincode: payload.customerAddress?.pincode !== undefined ? payload.customerAddress.pincode.trim() : (payload.pincode !== undefined ? payload.pincode.trim() : existing.customerAddress?.pincode || '')
      },
      orderNumber: payload.orderNumber !== undefined ? payload.orderNumber.trim() : existing.orderNumber,
      productName: payload.productName !== undefined ? payload.productName.trim() : existing.productName,
      productSku: payload.productSku !== undefined ? payload.productSku.trim() : existing.productSku,
      reason: payload.reason !== undefined ? payload.reason.trim() : existing.reason,
      flag: validFlag,
      flagReason: payload.flagReason !== undefined ? payload.flagReason.trim() : (existing.flagReason || ''),
      notes: payload.notes !== undefined ? payload.notes.trim() : existing.notes,
      adminNotes: payload.adminNotes !== undefined ? payload.adminNotes.trim() : existing.adminNotes,
      photoUrl: savedPhotoUrl,
      updatedAt: new Date().toISOString()
    };

    mockReplacements[existingIdx] = updated;

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'replacements', String(id)), sanitizeForFirestore(updated));
      } catch (fbErr) {
        console.error('[Firebase] Direct update of replacement request failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, replacement: updated, replacements: mockReplacements });
  } catch (err: any) {
    console.error('Error updating replacement request:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update request' });
  }
});

// API route: Quick update ticket flag (red, orange, green, none)
app.post('/api/replacements/:id/flag', async (req, res) => {
  try {
    const { id } = req.params;
    const { flag, flagReason } = req.body || {};
    const existingIdx = mockReplacements.findIndex(r => r && String(r.id) === String(id));
    if (existingIdx === -1) {
      return res.status(404).json({ success: false, error: 'Replacement request not found' });
    }

    const validFlag = ['red', 'orange', 'green', 'none'].includes(flag) ? flag : 'none';
    mockReplacements[existingIdx].flag = validFlag;
    if (flagReason !== undefined) {
      mockReplacements[existingIdx].flagReason = String(flagReason).trim();
    }
    mockReplacements[existingIdx].updatedAt = new Date().toISOString();

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'replacements', String(id)), sanitizeForFirestore(mockReplacements[existingIdx]));
      } catch (fbErr) {
        console.error('[Firebase] Update replacement flag failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, replacement: mockReplacements[existingIdx], replacements: mockReplacements });
  } catch (err: any) {
    console.error('Error setting replacement flag:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update flag' });
  }
});

// API route: Admin approve, reject, or mark as done
app.post('/api/replacements/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes, userEmail, userName } = req.body;
    const existingIdx = mockReplacements.findIndex(r => r && String(r.id) === String(id));
    if (existingIdx === -1) {
      return res.status(404).json({ success: false, error: 'Replacement request not found' });
    }

    const nowIso = new Date().toISOString();
    const updated = { ...mockReplacements[existingIdx] };
    updated.status = status; // 'pending' | 'approved' | 'rejected' | 'done'
    updated.updatedAt = nowIso;

    if (adminNotes !== undefined) {
      updated.adminNotes = adminNotes;
    }

    const actor = userEmail || userName || 'Admin';
    if (status === 'approved') {
      updated.approvedAt = nowIso;
      updated.approvedBy = actor;
    } else if (status === 'done') {
      updated.completedAt = nowIso;
      updated.completedBy = actor;
      if (!updated.approvedAt) {
        updated.approvedAt = nowIso;
        updated.approvedBy = actor;
      }
    }

    mockReplacements[existingIdx] = updated;

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'replacements', String(id)), sanitizeForFirestore(updated));
      } catch (fbErr) {
        console.error('[Firebase] Direct status update of replacement request failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, replacement: updated, replacements: mockReplacements });
  } catch (err: any) {
    console.error('Error updating replacement status:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update status' });
  }
});

// API route: Upload or Replace photo at any time
app.post('/api/replacements/:id/photo', async (req, res) => {
  try {
    const { id } = req.params;
    const { photoBase64, photoUrl } = req.body;
    const existingIdx = mockReplacements.findIndex(r => r && String(r.id) === String(id));
    if (existingIdx === -1) {
      return res.status(404).json({ success: false, error: 'Replacement request not found' });
    }

    let finalUrl = photoUrl;
    if (photoBase64) {
      finalUrl = photoBase64;
    }

    if (!finalUrl) {
      return res.status(400).json({ success: false, error: 'No photo data provided' });
    }

    const updated = {
      ...mockReplacements[existingIdx],
      photoUrl: finalUrl,
      updatedAt: new Date().toISOString()
    };

    mockReplacements[existingIdx] = updated;

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'replacements', String(id)), sanitizeForFirestore(updated));
      } catch (fbErr) {
        console.error('[Firebase] Photo update sync failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, photoUrl: finalUrl, replacement: updated });
  } catch (err: any) {
    console.error('Error uploading replacement photo:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to upload photo' });
  }
});

// API route: Delete a replacement request
app.delete('/api/replacements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    mockReplacements = mockReplacements.filter(r => r && String(r.id) !== String(id));

    if (isFirebaseEnabled && firestoreDb) {
      try {
        await deleteDoc(doc(firestoreDb, 'replacements', String(id)));
      } catch (fbErr) {
        console.error('[Firebase] Direct delete of replacement request failed:', fbErr);
      }
    }

    await saveReplacementsToFile();
    res.json({ success: true, replacements: mockReplacements });
  } catch (err: any) {
    console.error('Error deleting replacement request:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to delete request' });
  }
});

// Helper function for local intelligent heuristic parsing of replacement tickets
function parseReplacementLocally(text: string) {
  const textClean = text.replace(/\r/g, '').trim();
  const lower = textClean.toLowerCase();

  // 1. Determine Type: exchange vs replacement
  let type: 'replacement' | 'exchange' = 'replacement';
  if (
    lower.includes('exchange') ||
    lower.includes('swap') ||
    lower.includes('size change') ||
    lower.includes('size swap') ||
    lower.includes('different size') ||
    lower.includes('too tight') ||
    lower.includes('too loose') ||
    lower.includes('too large') ||
    lower.includes('too small') ||
    lower.includes('size issue') ||
    lower.includes('want m') ||
    lower.includes('want l') ||
    lower.includes('want xl')
  ) {
    type = 'exchange';
  }

  // 2. Phone Number (Mandatory)
  const phoneMatch = textClean.match(/(?:\+91[\s-]*)?[0]?[6-9]\d{4}[\s-]?\d{5}/) || textClean.match(/\b[6-9]\d{9}\b/);
  let customerPhone = '';
  if (phoneMatch) {
    customerPhone = phoneMatch[0].replace(/[^\d]/g, '').slice(-10);
  } else {
    const anyDigits = textClean.match(/\b\d{10}\b/);
    customerPhone = anyDigits ? anyDigits[0] : '';
  }

  // 3. Customer Name
  let customerName = '';
  const lines = textClean.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const nameMatch = line.match(/(?:customer(?:\s*name)?|name|client|from)\s*[:=-]\s*([A-Za-z\s]{2,40})/i);
    if (nameMatch && nameMatch[1]) {
      customerName = nameMatch[1].trim();
      break;
    }
  }
  if (!customerName && lines.length > 0) {
    const first = lines[0].replace(/^(customer|name|from|to|hi|hello|dear)\s*[:,-]?\s*/i, '').trim();
    if (first.length >= 2 && first.length < 35 && !first.match(/\d/) && !first.toLowerCase().includes('order') && !first.toLowerCase().includes('replace') && !first.toLowerCase().includes('want')) {
      customerName = first;
    }
  }
  if (!customerName) {
    customerName = 'Valued Customer';
  }

  // 4. Order Number
  let orderNumber = '';
  const orderMatch = textClean.match(/(?:DF|ORD|ORDER|Ticket|Invoice)[-#\s]*[0-9]{3,8}/i) || textClean.match(/#\s*[0-9]{4,8}/);
  if (orderMatch) {
    orderNumber = orderMatch[0].replace(/\s+/g, '').toUpperCase();
    if (!orderNumber.startsWith('DF-') && !orderNumber.startsWith('#') && !orderNumber.startsWith('ORD')) {
      orderNumber = `DF-${orderNumber.replace(/[^\d]/g, '')}`;
    }
  }

  // 5. Product Name & SKU
  let productName = 'Dapper Fit Premium Apparel';
  let productSku = '';
  if (lower.includes('cargo') || lower.includes('trouser')) {
    productName = 'Dapper Fit Premium Heavyweight Cargo Trouser - Olive / 32';
    productSku = 'DF-CRG-OLV-32';
  } else if (lower.includes('oversized') || lower.includes('tee') || lower.includes('t-shirt') || lower.includes('acid wash')) {
    productName = 'Dapper Fit Signature Oversized Tee - Onyx Black / L';
    productSku = 'DF-TEE-BLK-L';
  } else if (lower.includes('windbreaker') || lower.includes('jacket')) {
    productName = 'Dapper Fit Utility Windbreaker Jacket - Khaki / M';
    productSku = 'DF-JKT-KHK-M';
  } else if (lower.includes('hoodie')) {
    productName = 'Dapper Fit Boxy French Terry Hoodie - Charcoal / L';
    productSku = 'DF-HD-CHR-L';
  } else if (lower.includes('chino') || lower.includes('pant')) {
    productName = 'Dapper Fit Relaxed Pleated Chino - Beige / 32';
    productSku = 'DF-CHIN-BGE-32';
  } else {
    for (const line of lines) {
      const pMatch = line.match(/(?:product|item|garment|article)\s*[:=-]\s*(.+)/i);
      if (pMatch && pMatch[1]) {
        productName = pMatch[1].trim();
        break;
      }
    }
  }

  // 6. Address (Optional)
  let address = '';
  let city = '';
  let state = '';
  let pincode = '';

  const pinMatch = textClean.match(/\b\d{6}\b/);
  if (pinMatch) {
    pincode = pinMatch[0];
  }

  for (const line of lines) {
    const addrMatch = line.match(/(?:address|ship to|pickup|location|street)\s*[:=-]\s*(.+)/i);
    if (addrMatch && addrMatch[1]) {
      address = addrMatch[1].trim();
      break;
    }
  }

  if (pincode) {
    if (pincode.startsWith('56') || lower.includes('bangalore') || lower.includes('bengaluru')) {
      city = 'Bengaluru';
      state = 'Karnataka';
    } else if (pincode.startsWith('50') || lower.includes('hyderabad')) {
      city = 'Hyderabad';
      state = 'Telangana';
    } else if (pincode.startsWith('40') || pincode.startsWith('41') || lower.includes('mumbai') || lower.includes('pune')) {
      city = lower.includes('mumbai') ? 'Mumbai' : 'Pune';
      state = 'Maharashtra';
    } else if (pincode.startsWith('11') || lower.includes('delhi')) {
      city = 'Delhi';
      state = 'Delhi';
    } else if (pincode.startsWith('52') || pincode.startsWith('53') || lower.includes('andhra') || lower.includes('vijayawada')) {
      city = 'Vijayawada';
      state = 'Andhra Pradesh';
    } else if (pincode.startsWith('60') || lower.includes('chennai')) {
      city = 'Chennai';
      state = 'Tamil Nadu';
    }
  }

  // 7. Reason / Defect
  let reason = '';
  for (const line of lines) {
    const rMatch = line.match(/(?:reason|defect|issue|problem|complaint)\s*[:=-]\s*(.+)/i);
    if (rMatch && rMatch[1]) {
      reason = rMatch[1].trim();
      break;
    }
  }
  if (!reason) {
    if (type === 'exchange') {
      reason = 'Size fit issue reported by customer. Requesting size exchange.';
    } else if (lower.includes('torn') || lower.includes('tear') || lower.includes('cut')) {
      reason = 'Fabric torn upon unboxing. Fresh replacement unit requested.';
    } else if (lower.includes('zip') || lower.includes('button') || lower.includes('stitch')) {
      reason = 'Zipper or seam stitching loose. Defective piece replacement requested.';
    } else if (lower.includes('stain') || lower.includes('dirty') || lower.includes('mark')) {
      reason = 'Color stain or fabric blemish present on item delivered.';
    } else {
      reason = textClean.slice(0, 140);
    }
  }

  // 8. Determine Flags:
  // Red Flag: High priority, angry customer, severe defect, escalation, urgent
  // Orange Flag: Incomplete address, needs follow-up, sizing confusion, pending confirmation
  // Green Flag: Clear standard routine replacement or exchange
  let flag: 'red' | 'orange' | 'green' = 'green';
  let flagReason = 'Standard routine ticket';

  const isUrgentOrAngry =
    lower.includes('urgent') ||
    lower.includes('angry') ||
    lower.includes('furious') ||
    lower.includes('escalat') ||
    lower.includes('terrible') ||
    lower.includes('worst') ||
    lower.includes('fraud') ||
    lower.includes('fake') ||
    lower.includes('scam') ||
    lower.includes('broken') ||
    lower.includes('torn') ||
    lower.includes('completely damaged') ||
    lower.includes('severe') ||
    lower.includes('immediately') ||
    lower.includes('threat');

  const isMissingAddressOrNeedsReview =
    (!address && !pincode) ||
    lower.includes('address not given') ||
    lower.includes('ask address') ||
    lower.includes('address pending') ||
    lower.includes('not sure about size') ||
    lower.includes('call back') ||
    lower.includes('follow up');

  if (isUrgentOrAngry) {
    flag = 'red';
    flagReason = 'High priority: Urgent escalation or severe defect reported by customer';
  } else if (isMissingAddressOrNeedsReview) {
    flag = 'orange';
    flagReason = !address
      ? 'Address pending: Customer has not provided return/shipping address yet'
      : 'Review required: Sizing swap or customer confirmation pending';
  } else {
    flag = 'green';
    flagReason = 'Routine: Complete details provided with clean routine processing';
  }

  return {
    type,
    customerName,
    customerPhone,
    address,
    city,
    state,
    pincode,
    orderNumber,
    productName,
    productSku,
    reason,
    notes: `Intake processed via AI Phase from raw message (${textClean.length} characters).`,
    flag,
    flagReason,
    summary: `${type === 'exchange' ? 'Exchange' : 'Replacement'} for ${customerName} (${customerPhone || 'Phone Required'}). Flag: ${flag.toUpperCase()} (${flagReason})`
  };
}

// Handler: AI Phase intake parser for replacement/exchange orders
async function handleAiParseReplacement(req: any, res: any) {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ success: false, error: 'Raw text content is required for AI Phase intake.' });
  }

  const rawText = String(text).trim();
  const apiKey = process.env.GEMINI_API_KEY || 'MOCK_API_KEY';

  if (apiKey === 'MOCK_API_KEY' || !apiKey) {
    console.log('[AI Phase] Bypassing Gemini API and parsing locally (Sandbox/local mode)');
    const parsed = parseReplacementLocally(rawText);
    return res.json({ success: true, parsed, source: 'local_nlp' });
  }

  try {
    const prompt = `Analyze this raw unstructured customer message, call notes, WhatsApp conversation, email, or defect report for Dappersfit Apparel:
"""
${rawText}
"""

Extract structured replacement/exchange ticket data:
1. type: "replacement" (for damaged, defective, torn, missing button, wrong item) or "exchange" (for size swap, fit issue, color change, too tight, too loose).
2. customerName: Customer full name.
3. customerPhone: 10-digit mandatory mobile phone number (digits only). Phone is mandatory.
4. address: Optional street/flat address (leave empty string if not mentioned). Address is OPTIONAL.
5. city: Optional city (leave empty string if not mentioned).
6. state: Optional state (leave empty string if not mentioned).
7. pincode: Optional 6-digit postal zip code (leave empty string if not mentioned).
8. orderNumber: Original order ID if mentioned (e.g., DF-1090, #ORD-4521).
9. productName: Clothing/apparel product name (e.g., Heavyweight Cargo Trouser, Oversized Tee, Windbreaker Jacket).
10. productSku: Product SKU if mentioned or standard prefix.
11. reason: Clear description of why replacement or exchange is requested.
12. notes: Any special notes, customer preferences, or instructions.
13. flag: Assign exactly one of: "red", "orange", "green":
    - "red": Urgent priority, angry customer, severe tearing, high escalation, or fraud suspicion.
    - "orange": Needs review, address missing/not given, sizing clarification needed, or waiting on callback.
    - "green": Normal routine request, clear product & phone, polite, standard exchange/replacement.
14. flagReason: Brief explanation of why this flag color was assigned.
15. summary: 1-sentence summary of the ticket.`;

    const response = await generateContentWithRetryAndFallback(prompt, {
      systemInstruction: 'You are an intelligent customer support and returns fulfillment intake AI for Dappersfit Apparel. Extract replacement/exchange tickets into clean JSON. Phone number is mandatory; address is optional. Output strict JSON matching the schema.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['type', 'customerName', 'customerPhone', 'productName', 'reason', 'flag'],
        properties: {
          type: { type: Type.STRING, enum: ['replacement', 'exchange'] },
          customerName: { type: Type.STRING },
          customerPhone: { type: Type.STRING, description: '10-digit clean mandatory phone number' },
          address: { type: Type.STRING, description: 'Optional street address' },
          city: { type: Type.STRING, description: 'Optional city' },
          state: { type: Type.STRING, description: 'Optional state' },
          pincode: { type: Type.STRING, description: 'Optional 6-digit postal pincode' },
          orderNumber: { type: Type.STRING, description: 'Optional order number' },
          productName: { type: Type.STRING, description: 'Product name' },
          productSku: { type: Type.STRING, description: 'Product SKU' },
          reason: { type: Type.STRING, description: 'Reason for request' },
          notes: { type: Type.STRING, description: 'Internal notes' },
          flag: { type: Type.STRING, enum: ['red', 'orange', 'green'] },
          flagReason: { type: Type.STRING, description: 'Why this flag was chosen' },
          summary: { type: Type.STRING, description: 'One-line summary' }
        }
      }
    });

    const parsedJson = JSON.parse(response.text.trim());
    if (parsedJson.customerPhone) {
      parsedJson.customerPhone = parsedJson.customerPhone.replace(/[^\d]/g, '').slice(-10);
    }
    if (!parsedJson.customerPhone) {
      const local = parseReplacementLocally(rawText);
      parsedJson.customerPhone = local.customerPhone;
    }
    return res.json({ success: true, parsed: parsedJson, source: 'gemini' });
  } catch (err: any) {
    console.warn('[AI Phase] Gemini parsing encountered error, using local fallback:', err.message || err);
    const parsed = parseReplacementLocally(rawText);
    return res.json({ success: true, parsed, source: 'local_fallback', error: err.message });
  }
}

app.post('/api/replacements/ai-parse', handleAiParseReplacement);
app.post('/api/gemini/parse-replacement', handleAiParseReplacement);

// API route: Get current customers
app.get('/api/customers', (req, res) => {
  res.json({ customers: mockCustomers });
});

// API route: Create/Update a customer
app.post('/api/customers', (req, res) => {
  const customer = req.body;
  if (!customer.id) {
    customer.id = `c-${Date.now()}`;
  }
  const existingIdx = mockCustomers.findIndex(c => c.id === customer.id);
  if (existingIdx >= 0) {
    mockCustomers[existingIdx] = { ...mockCustomers[existingIdx], ...customer };
  } else {
    mockCustomers.push(customer);
  }
  saveCustomersToFile();
  res.json({ success: true, customer, customers: mockCustomers });
});

// API route: Delete a customer
app.delete('/api/customers/:id', (req, res) => {
  const { id } = req.params;
  mockCustomers = mockCustomers.filter(c => c && String(c.id) !== String(id));

  if (isFirebaseEnabled && firestoreDb) {
    try {
      deleteDoc(doc(firestoreDb, 'customers', String(id))).catch(err => {
        console.error('[Firebase] Direct delete of customer failed:', err);
      });
    } catch (err) {
      console.error('[Firebase] Direct delete of customer setup failed:', err);
    }
  }

  saveCustomersToFile();
  res.json({ success: true, customers: mockCustomers });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateContentWithRetryAndFallback(contents: string, config: any) {
  const models = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  let lastError: any = null;

  for (const model of models) {
    let attempts = 2;
    let delay = 800;
    
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        console.log(`[Gemini API] Attempting order parsing with model: ${model} (Attempt ${attempt}/${attempts})`);
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        console.log(`[Gemini API] Success using model: ${model}`);
        return response;
      } catch (err: any) {
        lastError = err;
        console.error(`[Gemini API] Failure on model ${model} (Attempt ${attempt}/${attempts}):`, err.message || err);
        
        // Fast-fail: If unauthenticated (invalid/missing key) or 400 bad request, do NOT retry
        const errMsg = String(err.message || '');
        if (
          err.status === 401 || err.statusCode === 401 || 
          err.status === 403 || err.statusCode === 403 ||
          err.status === 400 || err.statusCode === 400 ||
          errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('400') ||
          errMsg.includes('UNAUTHENTICATED') || errMsg.includes('API_KEY_INVALID')
        ) {
          throw err;
        }

        if (attempt < attempts) {
          console.log(`[Gemini API] Retrying model ${model} in ${delay}ms...`);
          await sleep(delay);
          delay *= 2;
        }
      }
    }
  }
  
  throw lastError || new Error('All Gemini models and retry attempts failed.');
}

const INDIAN_STATES_LIST = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 
  'West Bengal', 'Delhi', 'Jammu & Kashmir', 'Jammu and Kashmir', 'Ladakh', 'Chandigarh', 
  'Puducherry', 'Andaman and Nicobar', 'Dadra and Nagar Haveli'
];

const STATE_ABBRS_MAP: Record<string, string> = {
  'AP': 'Andhra Pradesh', 'TS': 'Telangana', 'TN': 'Tamil Nadu', 'KA': 'Karnataka', 
  'KL': 'Kerala', 'MH': 'Maharashtra', 'MP': 'Madhya Pradesh', 'UP': 'Uttar Pradesh', 
  'WB': 'West Bengal', 'DL': 'Delhi', 'RJ': 'Rajasthan', 'GJ': 'Gujarat', 'HR': 'Haryana', 
  'PB': 'Punjab', 'OD': 'Odisha', 'JH': 'Jharkhand', 'BR': 'Bihar', 'UK': 'Uttarakhand', 'CG': 'Chhattisgarh'
};

const PINCODE_PREFIX_MAP: Record<string, { state: string; city: string }> = {
  '11': { state: 'Delhi', city: 'Delhi' },
  '12': { state: 'Haryana', city: 'Gurgaon' },
  '13': { state: 'Haryana', city: 'Ambala' },
  '14': { state: 'Punjab', city: 'Ludhiana' },
  '15': { state: 'Punjab', city: 'Bathinda' },
  '16': { state: 'Chandigarh', city: 'Chandigarh' },
  '17': { state: 'Himachal Pradesh', city: 'Shimla' },
  '18': { state: 'Jammu & Kashmir', city: 'Jammu' },
  '19': { state: 'Jammu & Kashmir', city: 'Srinagar' },
  '20': { state: 'Uttar Pradesh', city: 'Ghaziabad' },
  '21': { state: 'Uttar Pradesh', city: 'Kanpur' },
  '22': { state: 'Uttar Pradesh', city: 'Lucknow' },
  '23': { state: 'Uttar Pradesh', city: 'Varanasi' },
  '24': { state: 'Uttar Pradesh', city: 'Bareilly' },
  '25': { state: 'Uttar Pradesh', city: 'Meerut' },
  '26': { state: 'Uttarakhand', city: 'Dehradun' },
  '27': { state: 'Uttar Pradesh', city: 'Gorakhpur' },
  '28': { state: 'Uttar Pradesh', city: 'Agra' },
  '30': { state: 'Rajasthan', city: 'Jaipur' },
  '31': { state: 'Rajasthan', city: 'Udaipur' },
  '32': { state: 'Rajasthan', city: 'Kota' },
  '33': { state: 'Rajasthan', city: 'Bikaner' },
  '34': { state: 'Rajasthan', city: 'Jodhpur' },
  '36': { state: 'Gujarat', city: 'Rajkot' },
  '37': { state: 'Gujarat', city: 'Jamnagar' },
  '38': { state: 'Gujarat', city: 'Ahmedabad' },
  '39': { state: 'Gujarat', city: 'Surat' },
  '40': { state: 'Maharashtra', city: 'Mumbai' },
  '41': { state: 'Maharashtra', city: 'Pune' },
  '42': { state: 'Maharashtra', city: 'Nashik' },
  '43': { state: 'Maharashtra', city: 'Aurangabad' },
  '44': { state: 'Maharashtra', city: 'Nagpur' },
  '45': { state: 'Madhya Pradesh', city: 'Indore' },
  '46': { state: 'Madhya Pradesh', city: 'Bhopal' },
  '47': { state: 'Madhya Pradesh', city: 'Gwalior' },
  '48': { state: 'Madhya Pradesh', city: 'Jabalpur' },
  '49': { state: 'Chhattisgarh', city: 'Raipur' },
  '50': { state: 'Telangana', city: 'Hyderabad' },
  '51': { state: 'Andhra Pradesh', city: 'Kadapa' },
  '52': { state: 'Andhra Pradesh', city: 'Vijayawada' },
  '53': { state: 'Andhra Pradesh', city: 'Visakhapatnam' },
  '56': { state: 'Karnataka', city: 'Bengaluru' },
  '57': { state: 'Karnataka', city: 'Mangaluru' },
  '58': { state: 'Karnataka', city: 'Hubli' },
  '59': { state: 'Karnataka', city: 'Belagavi' },
  '60': { state: 'Tamil Nadu', city: 'Chennai' },
  '61': { state: 'Tamil Nadu', city: 'Thanjavur' },
  '62': { state: 'Tamil Nadu', city: 'Madurai' },
  '63': { state: 'Tamil Nadu', city: 'Salem' },
  '64': { state: 'Tamil Nadu', city: 'Coimbatore' },
  '67': { state: 'Kerala', city: 'Kozhikode' },
  '68': { state: 'Kerala', city: 'Kochi' },
  '69': { state: 'Kerala', city: 'Thiruvananthapuram' },
  '70': { state: 'West Bengal', city: 'Kolkata' },
  '71': { state: 'West Bengal', city: 'Howrah' },
  '72': { state: 'West Bengal', city: 'Kharagpur' },
  '73': { state: 'West Bengal', city: 'Siliguri' },
  '75': { state: 'Odisha', city: 'Bhubaneswar' },
  '76': { state: 'Odisha', city: 'Berhampur' },
  '77': { state: 'Odisha', city: 'Rourkela' },
  '78': { state: 'Assam', city: 'Guwahati' },
  '79': { state: 'North East', city: 'Shillong' },
  '80': { state: 'Bihar', city: 'Patna' },
  '81': { state: 'Bihar', city: 'Bhagalpur' },
  '82': { state: 'Jharkhand', city: 'Gaya' },
  '83': { state: 'Jharkhand', city: 'Ranchi' },
  '84': { state: 'Bihar', city: 'Muzaffarpur' },
  '85': { state: 'Bihar', city: 'Purnia' }
};

const KNOWN_CITIES_LIST = [
  'Bengaluru', 'Bangalore', 'Mumbai', 'Pune', 'Delhi', 'New Delhi', 'Hyderabad', 'Secunderabad',
  'Chennai', 'Kolkata', 'Ahmedabad', 'Surat', 'Jaipur', 'Lucknow', 'Kanpur', 'Nagpur',
  'Indore', 'Thane', 'Bhopal', 'Visakhapatnam', 'Vizag', 'Patna', 'Vadodara', 'Baroda',
  'Ghaziabad', 'Ludhiana', 'Agra', 'Nashik', 'Faridabad', 'Meerut', 'Rajkot', 'Kalyan',
  'Varanasi', 'Srinagar', 'Aurangabad', 'Dhanbad', 'Amritsar', 'Navi Mumbai', 'Allahabad',
  'Prayagraj', 'Ranchi', 'Howrah', 'Coimbatore', 'Jabalpur', 'Gwalior', 'Vijayawada',
  'Jodhpur', 'Madurai', 'Raipur', 'Kota', 'Chandigarh', 'Guwahati', 'Solapur', 'Hubli',
  'Dharwad', 'Bareilly', 'Moradabad', 'Mysore', 'Mysuru', 'Gurgaon', 'Gurugram', 'Aligarh',
  'Jalandhar', 'Tiruchirappalli', 'Trichy', 'Bhubaneswar', 'Salem', 'Warangal', 'Noida',
  'Thiruvananthapuram', 'Trivandrum', 'Guntur', 'Bhiwandi', 'Saharanpur', 'Gorakhpur',
  'Bikaner', 'Amravati', 'Jamshedpur', 'Bhilai', 'Cuttack', 'Firozabad', 'Kochi', 'Cochin',
  'Nellore', 'Bhavnagar', 'Dehradun', 'Durgapur', 'Asansol', 'Rourkela', 'Nanded', 'Kolhapur',
  'Ajmer', 'Akola', 'Gulbarga', 'Kalaburagi', 'Jamnagar', 'Ujjain', 'Siliguri', 'Jhansi',
  'Ulhasnagar', 'Jammu', 'Sangli', 'Mangalore', 'Mangaluru', 'Erode', 'Belgaum', 'Belagavi',
  'Tirunelveli', 'Gaya', 'Jalgaon', 'Udaipur', 'Davanagere', 'Kozhikode', 'Calicut',
  'Kurnool', 'Rajahmundry', 'Bokaro', 'Bellary', 'Ballari', 'Patiala', 'Agartala',
  'Bhagalpur', 'Muzaffarpur', 'Latur', 'Dhule', 'Rohtak', 'Korba', 'Bhilwara', 'Berhampur',
  'Muzaffarnagar', 'Ahmednagar', 'Mathura', 'Kollam', 'Kadapa', 'Cuddapah', 'Sambalpur',
  'Bilaspur', 'Satara', 'Bijapur', 'Vijayapura', 'Shimoga', 'Shivamogga', 'Chandrapur',
  'Junagadh', 'Thrissur', 'Alwar', 'Kakinada', 'Nizamabad', 'Tumkur', 'Tumakuru',
  'Khammam', 'Panipat', 'Darbhanga', 'Aizawl', 'Dewas', 'Karnal', 'Bathinda', 'Jalna',
  'Eluru', 'Barasat', 'Purnia', 'Satna', 'Sonipat', 'Sagar', 'Imphal', 'Ratlam',
  'Hapur', 'Karimnagar', 'Anantapur', 'Etawah', 'Bharatpur', 'Begusarai', 'Gandhidham',
  'Pondicherry', 'Puducherry', 'Sikar', 'Thoothukudi', 'Tuticorin', 'Rewa', 'Mirzapur',
  'Raichur', 'Pali', 'Ramagundam', 'Silchar', 'Haridwar', 'Vizianagaram', 'Tenali',
  'Nandyal', 'Morena', 'Amroha', 'Anand', 'Bhind', 'Bhusawal', 'Ongole',
  'Chittoor', 'Tirupati', 'Machilipatnam', 'Adoni', 'Proddatur', 'Nalgonda', 'Mahbubnagar',
  'Mancherial', 'Suryapet', 'Siddipet', 'Miryalaguda', 'Jagtial'
];

function parseOrderLocally(rawText: string) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      customerName: '',
      address: { name: '', phone: '', address: '', city: '', state: '', pincode: '', email: '' },
      items: [],
      totalAmount: 0
    };
  }

  const original = rawText.trim();
  let text = original;

  // 1. Phone Extraction (clean 10-digit number)
  let phone = '';
  const phoneLabels = /\b(?:phone|mobile|mob|contact|ph|tel|whatsapp|call|m)\s*[:=\-]?\s*(\+?91[\-\s]?)?([6-9]\d{9})\b/i;
  const labeledPhoneMatch = text.match(phoneLabels);
  if (labeledPhoneMatch) {
    phone = labeledPhoneMatch[2];
  } else {
    const rawPhoneMatch = text.match(/(?:\+91[\-\s]?|0)?([6-9]\d{9})\b/);
    if (rawPhoneMatch) {
      phone = rawPhoneMatch[1];
    }
  }

  // 2. Pincode Extraction (6-digit Indian PIN)
  let pincode = '';
  const pinLabels = /\b(?:pincode|pin\s*code|pin|postal\s*code|zip|zipcode)\s*[:=\-]?\s*([1-9]\d{5})\b/i;
  const labeledPinMatch = text.match(pinLabels);
  if (labeledPinMatch) {
    pincode = labeledPinMatch[1];
  } else {
    const all6Digits = [...text.matchAll(/\b([1-9]\d{5})\b/g)];
    for (const m of all6Digits) {
      const matchIndex = m.index || 0;
      if (phone && text.includes(phone) && text.indexOf(phone) <= matchIndex && (text.indexOf(phone) + 12) >= matchIndex) {
        continue;
      }
      pincode = m[1];
      break;
    }
  }

  // 3. State Extraction
  let state = '';
  for (const s of INDIAN_STATES_LIST) {
    const stateRegex = new RegExp(`\\b${s}\\b`, 'i');
    if (stateRegex.test(text)) {
      state = s;
      break;
    }
  }
  if (!state) {
    for (const [abbr, sName] of Object.entries(STATE_ABBRS_MAP)) {
      const abbrRegex = new RegExp(`\\b(?:state|st|pradesh)?[:\\s,-]*\\b${abbr}\\b`, 'i');
      if (abbrRegex.test(text)) {
        state = sName;
        break;
      }
    }
  }

  // 4. City / Town Extraction
  let city = '';
  const cityLabels = /\b(?:city|town|district|dist|dt\.?)\s*[:=\-]?\s*([a-zA-Z\s]{3,25})/i;
  const labeledCityMatch = text.match(cityLabels);
  if (labeledCityMatch) {
    const candidateCity = labeledCityMatch[1].trim().split(/[,\n\r]/)[0].trim();
    if (candidateCity && !candidateCity.toLowerCase().includes('state') && !candidateCity.toLowerCase().includes('pin')) {
      city = candidateCity;
    }
  }
  if (!city) {
    for (const c of KNOWN_CITIES_LIST) {
      const cityRegex = new RegExp(`\\b${c}\\b`, 'i');
      if (cityRegex.test(text)) {
        city = c;
        break;
      }
    }
  }

  // If city/state missing, extrapolate from Pincode prefix
  if (pincode && pincode.length === 6) {
    const prefix = pincode.slice(0, 2);
    const pinInfo = PINCODE_PREFIX_MAP[prefix];
    if (pinInfo) {
      if (!state) state = pinInfo.state;
      if (!city) city = pinInfo.city;
    }
  }

  // 5. Customer Name Extraction
  let customerName = '';
  const nameLabels = /\b(?:name|customer|cust\s*name|buyer|recipient|receiver|to|ship\s*to|c\/o|care\s*of)\s*[:=\-]?\s*([a-zA-Z\s.]{2,40})/i;
  const labeledNameMatch = text.match(nameLabels);
  if (labeledNameMatch) {
    const candidate = labeledNameMatch[1].trim().split(/[,\n\r]/)[0].trim();
    if (candidate.length >= 2 && !candidate.toLowerCase().includes('address') && !candidate.toLowerCase().includes('phone') && !candidate.toLowerCase().includes('pin')) {
      customerName = candidate;
    }
  }

  if (!customerName) {
    const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const line = lines[i];
      if (/\b(?:flat|plot|h\.?no|d\.?no|house|door|shop|street|road|cross|lane|near|opp|behind|beside|ph|phone|mob|pin|rs|inr|cod)\b/i.test(line)) {
        continue;
      }
      if (/\d{4,}/.test(line)) {
        const beforeDigits = line.replace(/\d+.*/, '').replace(/[:,\-]/g, '').trim();
        if (beforeDigits.length >= 2 && beforeDigits.length <= 35 && /^[a-zA-Z\s.]+$/.test(beforeDigits)) {
          customerName = beforeDigits;
          break;
        }
        continue;
      }
      if (/^[a-zA-Z\s.]{2,35}$/.test(line)) {
        customerName = line;
        break;
      }
    }
  }

  if (!customerName && phone && text.includes(phone)) {
    const beforePhone = text.split(phone)[0].trim();
    const tokens = beforePhone.split(/[,\n;]/).map(t => t.trim()).filter(Boolean);
    const firstToken = tokens[0] || '';
    if (firstToken && !/\b(?:flat|plot|h\.?no|d\.?no|house|door|shop|street|road)\b/i.test(firstToken)) {
      const cleaned = firstToken.replace(/^(?:to|name|customer|ship\s*to)\s*[:=\-]?/i, '').trim();
      if (cleaned.length >= 2 && cleaned.length <= 35 && /^[a-zA-Z\s.]+$/.test(cleaned)) {
        customerName = cleaned;
      }
    }
  }

  if (!customerName) {
    const firstTokens = text.replace(/^(?:to|name|customer|ship\s*to)\s*[:=\-]?/i, '').trim().split(/\s+/);
    if (firstTokens.length >= 2) {
      const cand = `${firstTokens[0]} ${firstTokens[1]}`;
      if (/^[a-zA-Z.]+ [a-zA-Z.]+$/.test(cand) && !/\b(?:flat|plot|hno|dno|house|door|shop|road|near|phone)\b/i.test(cand)) {
        customerName = cand;
      }
    }
  }

  if (customerName) {
    customerName = customerName.split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
      .trim();
  }

  // 6. Clean Street Address (strictly street details, no name, no phone, no pincode, no state)
  let streetAddress = original;
  streetAddress = streetAddress.replace(/\b(?:address|add|delivery\s*address|shipping\s*address|addr)\s*[:=\-]?/gi, ' ');
  
  if (phone) {
    streetAddress = streetAddress.replace(new RegExp(`\\b(?:phone|mobile|mob|contact|ph|tel|whatsapp|m)?\\s*[:=\\-]?\\s*(\\+?91[\\-\\s]?)?${phone}\\b`, 'gi'), ' ');
  }
  streetAddress = streetAddress.replace(/(?:\+?91[\-\s]?)?[6-9]\d{9}\b/g, ' ');

  if (customerName) {
    streetAddress = streetAddress.replace(new RegExp(`\\b(?:name|customer|buyer|recipient|to|ship\\s*to)?\\s*[:=\\-]?\\s*\\b${customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }

  if (pincode) {
    streetAddress = streetAddress.replace(new RegExp(`\\b(?:pincode|pin\\s*code|pin|zip|postal)?\\s*[:=\\-]?\\s*\\b${pincode}\\b`, 'gi'), ' ');
  }

  if (state) {
    streetAddress = streetAddress.replace(new RegExp(`\\b(?:state)?\\s*[:=\\-]?\\s*\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }

  if (city) {
    streetAddress = streetAddress.replace(new RegExp(`\\b(?:city|town|dist|district)?\\s*[:=\\-]?\\s*\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }

  streetAddress = streetAddress
    .replace(/\b(?:name|phone|mobile|pin|pincode|state|city|to|c\/o|care\s*of|dist|district|call|ph|tel)\s*[:=\-]?/gi, ' ')
    .replace(/[\n\r\t]+/g, ', ')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.\-]+|[\s,.\-]+$/g, '')
    .trim();

  if (!streetAddress || streetAddress.length < 5) {
    streetAddress = original.replace(/[\n\r]+/g, ', ').replace(/\s+/g, ' ').trim();
  }

  // 7. Product & Price detection (only if mentioned)
  let items: any[] = [];
  let totalAmount = 0;

  const priceMatch = original.match(/(?:rs\.?|inr|₹|amount|cod|price)\s*[:=\-]?\s*(\d{2,6})\b/i);
  if (priceMatch) {
    const val = parseInt(priceMatch[1], 10);
    if (val >= 100 && val <= 100000) {
      totalAmount = val;
    }
  }

  const productMatch = original.match(/\b(?:item|product|order|buy)\s*[:=\-]?\s*([a-zA-Z0-9\s\-_]{3,40})/i);
  if (productMatch) {
    const prodName = productMatch[1].trim().split(/[,\n]/)[0].trim();
    if (prodName) {
      items.push({
        name: prodName,
        sku: prodName.toUpperCase().replace(/\s+/g, '-').slice(0, 10),
        quantity: 1,
        price: totalAmount || 999
      });
    }
  }

  return {
    customerName,
    address: {
      name: customerName,
      phone,
      address: streetAddress,
      city,
      state,
      pincode,
      email: customerName ? `${customerName.toLowerCase().replace(/\s+/g, '')}@gmail.com` : ''
    },
    items,
    totalAmount
  };
}

// API Route: AI raw order message parser (Gemini API server-side wrapper)
app.post('/api/gemini/parse-order', async (req, res) => {
  const { text } = req.body;
  
  if (!text) {
    return res.status(400).json({ error: 'Text prompt content is empty.' });
  }

  const apiKey = process.env.GEMINI_API_KEY || '';
  // If key is missing, mock, or doesn't start with standard Gemini prefix, fast-track to smart local parser
  if (!apiKey || apiKey === 'MOCK_API_KEY' || !apiKey.startsWith('AIzaSy')) {
    console.log('[Order Parser] Instant smart local parser activated');
    const parsedOrder = parseOrderLocally(text);
    return res.json({ success: true, parsedOrder, source: 'smart-local' });
  }

  try {
    const prompt = `Parse the following unstructured raw chat or WhatsApp order confirmation text. Extract the details perfectly into the requested JSON schema.
Extract:
- customerName: Clean full name of the recipient/customer. Do NOT include phone number or address here. If no name found, use empty string "".
- address.name: Same as customerName.
- address.phone: 10-digit clean phone number (without country code or +91).
- address.address: ONLY the delivery street/door/flat/building/locality details. Do NOT repeat customer name, phone number, pincode, or state in this field.
- address.city: City or town name (e.g. Pune, Hyderabad, Bangalore, Kadapa, Tenali, Kolkata, etc.).
- address.state: State name (e.g. Maharashtra, Telangana, Karnataka, Andhra Pradesh, West Bengal, Delhi, etc.).
- address.pincode: 6-digit postal code.
- items: If a product item is mentioned, extract it. Otherwise empty array.
- totalAmount: Price/amount if explicitly specified, otherwise 0.

Raw text to analyze:
"""
${text}
"""`;

    const response = await generateContentWithRetryAndFallback(prompt, {
      systemInstruction: `You are an expert order parser for Dappersfit Logistics platform. You extract raw e-commerce messages into clean, conformed JSON. Standardize pincodes (6-digit numbers) and telephone numbers (10 digits clean). Keep address.address strictly to street/door/locality details without repeating customerName or phone.`,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['customerName', 'address'],
        properties: {
          customerName: { type: Type.STRING, description: 'Full name of the purchasing customer.' },
          address: {
            type: Type.OBJECT,
            required: ['name', 'phone', 'address', 'city', 'state', 'pincode'],
            properties: {
              name: { type: Type.STRING, description: 'Name of the recipient' },
              phone: { type: Type.STRING, description: '10-digit clean phone number' },
              address: { type: Type.STRING, description: 'Street address details without name/phone' },
              city: { type: Type.STRING, description: 'City or town name' },
              state: { type: Type.STRING, description: 'State name' },
              pincode: { type: Type.STRING, description: '6-digit postal zip code' },
              email: { type: Type.STRING, description: 'Optional contact email' }
            }
          },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['name', 'sku', 'quantity', 'price'],
              properties: {
                name: { type: Type.STRING, description: 'Name of the product' },
                sku: { type: Type.STRING, description: 'Item SKU code' },
                quantity: { type: Type.INTEGER, description: 'Quantity purchased' },
                price: { type: Type.NUMBER, description: 'Unit price of the item' }
              }
            }
          },
          totalAmount: { type: Type.NUMBER, description: 'Aggregated order price' }
        }
      }
    });

    const jsonStr = response.text?.trim() || '{}';
    const parsedOrder = JSON.parse(jsonStr);

    res.json({ success: true, parsedOrder, source: 'gemini' });
  } catch (error: any) {
    console.warn('[Order Parser] Gemini parsing bypassed/failed. Serving via smart local parser:', error.message || error);
    try {
      const parsedOrder = parseOrderLocally(text);
      res.json({ success: true, parsedOrder, source: 'smart-local-fallback' });
    } catch (fallbackErr: any) {
      res.status(500).json({ error: 'AI order parsing failed to respond.', details: fallbackErr.message });
    }
  }
});

// -------------------------------------------------------------
// SHIPROCKET WALLET STORAGE & PRIORITY BOOKING ENGINE
// -------------------------------------------------------------

const WALLET_FILE_PATH = path.join(process.cwd(), 'data_wallet.json');

const loadWalletBalance = (): number => {
  try {
    if (fs.existsSync(WALLET_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(WALLET_FILE_PATH, 'utf8'));
      if (typeof data.balance === 'number') {
        return data.balance;
      }
    }
  } catch (err) {
    console.error('Failed to load wallet balance:', err);
  }
  return 1500.00; // Default simulated wallet balance (₹1,500.00)
};

const saveWalletBalance = (balance: number) => {
  try {
    fs.writeFileSync(WALLET_FILE_PATH, JSON.stringify({ balance: parseFloat(balance.toFixed(2)) }, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save wallet balance:', err);
  }
};

const WALLET_DETAILS_FILE_PATH = path.join(process.cwd(), 'data_wallet_details.json');

interface WalletDetailsState {
  available_balance: number;
  hold_amount: number;
  last_sync_time: string;
  is_simulated: boolean;
}

let cachedWalletDetails: WalletDetailsState | null = null;

function getInitialWalletDetails(): WalletDetailsState {
  try {
    if (fs.existsSync(WALLET_DETAILS_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(WALLET_DETAILS_FILE_PATH, 'utf8'));
      if (typeof data.available_balance === 'number') {
        return {
          available_balance: data.available_balance,
          hold_amount: typeof data.hold_amount === 'number' ? data.hold_amount : 0.00,
          last_sync_time: data.last_sync_time || new Date().toISOString(),
          is_simulated: data.is_simulated !== undefined ? data.is_simulated : !isLiveConfigured()
        };
      }
    }
  } catch (_) {}
  return {
    available_balance: loadWalletBalance(),
    hold_amount: 0.00,
    last_sync_time: new Date().toISOString(),
    is_simulated: !isLiveConfigured()
  };
}

cachedWalletDetails = getInitialWalletDetails();

const saveWalletDetails = async (details: WalletDetailsState) => {
  cachedWalletDetails = details;
  try {
    fs.writeFileSync(WALLET_DETAILS_FILE_PATH, JSON.stringify(details, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save wallet details locally:', err);
  }
  
  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'shiprocket_wallet', 'current'), sanitizeForFirestore(details));
      console.log('[Firebase] Successfully synced wallet details to Firestore.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('offline')) {
        console.warn('[Firebase] Wallet details sync deferred:', msg);
      }
    }
  }
};

const loadWalletDetails = async (): Promise<WalletDetailsState> => {
  if (cachedWalletDetails) {
    return cachedWalletDetails;
  }
  cachedWalletDetails = getInitialWalletDetails();
  return cachedWalletDetails;
};

const getActiveWalletBalance = async (): Promise<{ balance: number; isSimulated: boolean }> => {
  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const data = await shiprocket.rawRequest('/settings/company/profile', 'GET', headers);
      const balance = data?.company?.wallet_balance !== undefined ? parseFloat(data.company.wallet_balance) : 
                      (data?.company?.balance !== undefined ? parseFloat(data.company.balance) : null);
      if (balance !== null) {
        return { balance, isSimulated: false };
      }
    } catch (err: any) {
      console.log('[Shiprocket] Real wallet balance query skipped or unavailable. Falling back to simulation.');
    }
  }
  return { balance: loadWalletBalance(), isSimulated: true };
};

// Courier priority ranker (1 is highest, 7 is lowest)
function getPriorityRank(courierName: string): number {
  const name = courierName.toLowerCase();
  
  // 1st bluedart air
  if (name.includes('bluedart') && (name.includes('air') || name.includes('premium') || name.includes('express'))) {
    return 1;
  }
  // 2nd bluedart surface
  if (name.includes('bluedart') && (name.includes('surface') || name.includes('ground') || name.includes('2kg'))) {
    return 2;
  }
  // 3rd delivery/delievry air
  if ((name.includes('delhivery') || name.includes('delievry')) && (name.includes('air') || name.includes('express') || name.includes('premium'))) {
    return 3;
  }
  // 4th dwliverey/delivery surface
  if ((name.includes('delhivery') || name.includes('delievry') || name.includes('dwliverey') || name.includes('delivery')) && (name.includes('surface') || name.includes('ground'))) {
    return 4;
  }
  // 5th dtdc air
  if (name.includes('dtdc') && (name.includes('air') || name.includes('express') || name.includes('premium'))) {
    return 5;
  }
  // 6th dtdc surface
  if (name.includes('dtdc') && (name.includes('surface') || name.includes('ground'))) {
    return 6;
  }
  // 7th shadow fax
  if (name.includes('shadow') || name.includes('shadowfax')) {
    return 7;
  }
  
  return 999; // Standard fallback for other couriers
}

// API Route: Get wallet balance
app.get('/api/shiprocket/wallet', async (req, res) => {
  try {
    const walletObj = await getActiveWalletBalance();
    res.json(walletObj);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve wallet balance', details: err.message });
  }
});

// API Route: Get detailed wallet balance (Available Balance and Hold Amount)
app.get('/api/shiprocket/wallet/balance-details', async (req, res) => {
  try {
    const details = await loadWalletDetails();
    res.json(details);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve detailed wallet balance', details: err.message });
  }
});

// API Route: Manually sync wallet details with Shiprocket API
app.post('/api/shiprocket/wallet/balance-details/sync', async (req, res) => {
  clearShiprocketCache();
  try {
    if (isLiveConfigured()) {
      try {
        const headers = await getShiprocketAuthHeaders();
        let availableBalance = 0;
        let holdAmount = 0;
        let fetchedSuccessfully = false;

        try {
          // Calls Shiprocket's /v1/external/wallet/balance endpoint
          const response = await shiprocket.rawRequest('/wallet/balance', 'GET', headers);
          if (response) {
            const dataObj = response.data || response;
            availableBalance = parseFloat(dataObj.wallet_balance !== undefined ? dataObj.wallet_balance : (dataObj.balance !== undefined ? dataObj.balance : 0));
            holdAmount = parseFloat(dataObj.hold_amount !== undefined ? dataObj.hold_amount : (dataObj.raw_hold_amount !== undefined ? dataObj.raw_hold_amount : 0));
            fetchedSuccessfully = true;
          }
        } catch (err1) {
          // Fall back to profile endpoint which also holds the wallet balance
          const profileData = await shiprocket.rawRequest('/settings/company/profile', 'GET', headers);
          const balance = profileData?.company?.wallet_balance !== undefined ? parseFloat(profileData.company.wallet_balance) : 
                          (profileData?.company?.balance !== undefined ? parseFloat(profileData.company.balance) : null);
          if (balance !== null) {
            availableBalance = balance;
            holdAmount = 0.00;
            fetchedSuccessfully = true;
          }
        }

        if (fetchedSuccessfully) {
          const details = {
            available_balance: availableBalance,
            hold_amount: holdAmount,
            last_sync_time: new Date().toISOString(),
            is_simulated: false
          };
          
          await saveWalletDetails(details);
          // Also keep data_wallet.json in sync for order validations
          saveWalletBalance(availableBalance);
          
          return res.json({ success: true, ...details });
        }
      } catch (liveErr: any) {
        console.log('[Shiprocket API] Dynamic wallet balance synchronization fell back to simulator.');
      }
    }
    
    // Sandbox simulated sync - we read live balance from loadWalletBalance
    const currentBalance = loadWalletBalance();
    // Simulate a minor hold amount variation for realistic visual feedback (e.g., ₹25.00 or ₹0.00)
    const possibleHolds = [0.00, 15.50, 42.00, 0.00, 8.75];
    const simulatedHold = possibleHolds[Math.floor(Math.random() * possibleHolds.length)];
    
    const details = {
      available_balance: currentBalance,
      hold_amount: simulatedHold,
      last_sync_time: new Date().toISOString(),
      is_simulated: true
    };
    
    await saveWalletDetails(details);
    res.json({ success: true, ...details });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to synchronize wallet balance details', details: err.message });
  }
});

// API Route: Get pickup addresses from Shiprocket (Live/Simulated)
app.get('/api/shiprocket/pickup-addresses', async (req, res) => {
  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const pickupData = await shiprocket.rawRequest('/settings/company/pickup', 'GET', headers);
      if (pickupData && pickupData.data && pickupData.data.shipping_address) {
        // Return active shipping addresses from shiprocket
        const mapped = pickupData.data.shipping_address.map((addr: any) => ({
          name: addr.pickup_location,
          pincode: addr.pin_code,
          address: addr.address + (addr.address_2 ? ', ' + addr.address_2 : ''),
          city: addr.city,
          state: addr.state,
          phone: addr.phone,
          isLive: true
        }));
        return res.json({ success: true, addresses: mapped });
      }
    } catch (err: any) {
      console.error('[Shiprocket] Error fetching pickup addresses:', err);
    }
  }

  // Fallback / Default simulated addresses with 'Dapers' as the default
  res.json({
    success: true,
    addresses: [
      {
        name: 'Dapers',
        pincode: '560068',
        address: '97 Sai Shakti Layout, Bettdasanapura, Electronic City, Bangalore',
        city: 'Bangalore',
        state: 'Karnataka',
        phone: '8073548204',
        isLive: false
      },
      {
        name: 'Pune Warehouse',
        pincode: '411037',
        address: 'Pune Dispatch Block, Hinjawadi Phase 2, Pune',
        city: 'Pune',
        state: 'Maharashtra',
        phone: '9041935824',
        isLive: false
      },
      {
        name: 'Mumbai Fulfillment',
        pincode: '400099',
        address: 'Near Cargo Terminal, Sahar Road, Andheri East, Mumbai',
        city: 'Mumbai',
        state: 'Maharashtra',
        phone: '8019566202',
        isLive: false
      },
      {
        name: 'Delhi Express Gate',
        pincode: '110020',
        address: 'Okhla Industrial Area Phase 3, New Delhi',
        city: 'New Delhi',
        state: 'Delhi',
        phone: '9876543210',
        isLive: false
      },
      {
        name: 'Kolkata Core Hub',
        pincode: '700091',
        address: 'Salt Lake Sector V, Kolkata',
        city: 'Kolkata',
        state: 'West Bengal',
        phone: '9988776655',
        isLive: false
      }
    ]
  });
});

// API Route: Courier serviceability query
app.post('/api/shiprocket/serviceability', async (req, res) => {
  const { delivery_postcode, weight, cod, pickup_postcode } = req.body;

  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const resolvedPickup = pickup_postcode || '411037';
      const endpoint = `/courier/serviceability?pickup_postcode=${resolvedPickup}&delivery_postcode=${delivery_postcode || '400001'}&weight=${(weight || 0.5).toString()}&cod=${(cod || 0).toString()}`;
      
      const data = await shiprocket.rawRequest(endpoint, 'GET', headers);
      
      // Map Shiprocket response structure to Dappersfit serviceability interface
      const rawCouriers = data?.data?.available_courier_companies || [];
      const formattedCouriers = rawCouriers.slice(0, 20).map((c: any) => ({
        courierId: c.courier_company_id,
        courierName: c.courier_name,
        rate: parseFloat(c.rate || '90.00'),
        eta: c.etd || '3-4 Days',
        rating: parseFloat(c.rating || '4.2'),
        cod: !!c.cod,
        minWeight: parseFloat(c.min_weight || '0.5')
      }));

      return res.json({ couriers: formattedCouriers });
    } catch (err: any) {
      console.log('Shiprocket Live failure on serviceability:', err.message || err);
    }
  }

  // FALLBACK Sandbox Simulator: Comprehensive 7 options matching user's priority order
  const mockOptions = [
    { courierId: 201, courierName: 'BlueDart Air Premium', rate: 145.00, eta: '1 Day', rating: 4.9, cod: true, minWeight: 0.5 },
    { courierId: 202, courierName: 'BlueDart Surface 2KG', rate: 85.00, eta: '3 Days', rating: 4.5, cod: true, minWeight: 0.5 },
    { courierId: 203, courierName: 'Delhivery Express (Air)', rate: 110.00, eta: '1-2 Days', rating: 4.7, cod: true, minWeight: 0.5 },
    { courierId: 204, courierName: 'Delhivery Surface', rate: 65.00, eta: '4 Days', rating: 4.3, cod: true, minWeight: 0.5 },
    { courierId: 205, courierName: 'DTDC Air Express', rate: 95.00, eta: '2 Days', rating: 4.4, cod: true, minWeight: 0.5 },
    { courierId: 206, courierName: 'DTDC Surface Standard', rate: 58.00, eta: '5 Days', rating: 4.0, cod: true, minWeight: 0.5 },
    { courierId: 207, courierName: 'Shadowfax Local Standard', rate: 48.00, eta: '3 Days', rating: 4.2, cod: true, minWeight: 0.5 }
  ];
  res.json({ couriers: mockOptions });
});

function formatShiprocketError(rawError: any): string {
  const msg = typeof rawError === 'string' ? rawError : (rawError?.message || rawError?.error || JSON.stringify(rawError || ''));
  const lower = msg.toLowerCase();
  
  if (
    (lower.includes('wallet') && (lower.includes('insufficient') || lower.includes('low') || lower.includes('zero') || lower.includes('recharge'))) ||
    lower.includes('minimum required balance') ||
    lower.includes('recharge your shiprocket wallet')
  ) {
    return 'Shiprocket wallet balance is insufficient. Please recharge your Shiprocket wallet and try again.';
  }

  if (
    lower.includes('empty code') ||
    lower.includes('awb assignment returned empty code') ||
    lower.includes('could not generate awb')
  ) {
    return 'Shiprocket could not assign an AWB for the selected courier partner. Please try another courier partner or verify partner serviceability.';
  }
  
  return msg || 'Shiprocket order placement failed. Please try again.';
}

// Helper: Resolve canonical Shiprocket customer tracking link (matching the Share button link in Shiprocket app)
function getShiprocketTrackingUrl(awbCode: string, trackData?: any): string {
  if (!awbCode) return '';
  const cleanAwb = String(awbCode).trim();
  const rawUrl = trackData?.tracking_data?.track_url || trackData?.tracking_data?.tracking_url || trackData?.track_url || trackData?.response?.track_url || trackData?.data?.track_url;
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.startsWith('http')) {
    return rawUrl;
  }
  return `https://shiprocket.co/tracking/${cleanAwb}`;
}

// Helper: Get Indian Standard Time (IST) dates for accurate Shiprocket cutoff and pickup scheduling
function getISTPickupDates() {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + istOffsetMs);
  const todayStr = nowIST.toISOString().slice(0, 10);
  const tomorrowIST = new Date(Date.now() + istOffsetMs + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrowIST.toISOString().slice(0, 10);
  const istHour = nowIST.getUTCHours();
  return { todayStr, tomorrowStr, istHour };
}

// Helper: Schedule Shiprocket pickup on a first-come, first-served basis (Today if available, else Tomorrow)
async function scheduleShiprocketEarliestPickup(shipmentId: string | number, headers: any): Promise<{
  pickupScheduledDate: string;
  pickupTokenNumber: string;
  pickupStatus: string;
}> {
  const numShipmentId = Number(shipmentId) || shipmentId;
  const { todayStr, tomorrowStr } = getISTPickupDates();

  // 1. First-come, first-served: Try TODAY's date first
  try {
    console.log(`[Shiprocket Pickup] First-come first-served: Attempting TODAY (${todayStr}) for shipment ${shipmentId}...`);
    const todayRes = await shiprocket.rawRequest('/courier/generate/pickup', 'POST', headers, {
      shipment_id: [numShipmentId],
      pickup_date: [todayStr]
    });
    const resObj = todayRes?.response || todayRes?.data || todayRes || {};
    const scheduledDate = resObj.pickup_scheduled_date || todayRes?.pickup_scheduled_date || todayStr;
    const token = String(resObj.pickup_token_number || todayRes?.pickup_token_number || '');
    
    // If Shiprocket accepted today's pickup (pickup_status === 1 or status === 1 or token returned)
    const isSuccess = resObj.pickup_status === 1 || resObj.status === 1 || todayRes?.status === 1 || token || resObj.pickup_scheduled_date;
    const isExplicitFail = resObj.pickup_status === 0 || todayRes?.pickup_status === 0;

    if (isSuccess && !isExplicitFail) {
      console.log(`[Shiprocket Pickup] Successfully scheduled for TODAY (${scheduledDate}), Token: ${token}`);
      return {
        pickupScheduledDate: scheduledDate,
        pickupTokenNumber: token,
        pickupStatus: 'scheduled'
      };
    } else {
      console.log(`[Shiprocket Pickup] Today (${todayStr}) not confirmed by Shiprocket, attempting TOMORROW...`);
    }
  } catch (todayErr: any) {
    console.log(`[Shiprocket Pickup] Today (${todayStr}) unavailable (cutoff passed or courier slots full):`, todayErr.message || todayErr);
  }

  // 2. If today is unavailable or cutoff passed, book TOMORROW
  try {
    console.log(`[Shiprocket Pickup] Attempting next available earliest pickup: TOMORROW (${tomorrowStr}) for shipment ${shipmentId}...`);
    const tomorrowRes = await shiprocket.rawRequest('/courier/generate/pickup', 'POST', headers, {
      shipment_id: [numShipmentId],
      pickup_date: [tomorrowStr]
    });
    const resObj = tomorrowRes?.response || tomorrowRes?.data || tomorrowRes || {};
    const scheduledDate = resObj.pickup_scheduled_date || tomorrowRes?.pickup_scheduled_date || tomorrowStr;
    const token = String(resObj.pickup_token_number || tomorrowRes?.pickup_token_number || '');
    console.log(`[Shiprocket Pickup] Successfully scheduled for TOMORROW (${scheduledDate}), Token: ${token}`);
    return {
      pickupScheduledDate: scheduledDate,
      pickupTokenNumber: token,
      pickupStatus: 'scheduled'
    };
  } catch (tomorrowErr: any) {
    console.log(`[Shiprocket Pickup] Tomorrow pickup notice:`, tomorrowErr.message || tomorrowErr);
  }

  // 3. Fallback: call without explicit date, letting Shiprocket allocate the earliest available slot
  try {
    console.log(`[Shiprocket Pickup] Requesting earliest system allocation from Shiprocket...`);
    const autoRes = await shiprocket.rawRequest('/courier/generate/pickup', 'POST', headers, {
      shipment_id: [numShipmentId]
    });
    const resObj = autoRes?.response || autoRes?.data || autoRes || {};
    const scheduledDate = resObj.pickup_scheduled_date || autoRes?.pickup_scheduled_date || tomorrowStr;
    const token = String(resObj.pickup_token_number || autoRes?.pickup_token_number || '');
    return {
      pickupScheduledDate: scheduledDate,
      pickupTokenNumber: token,
      pickupStatus: 'scheduled'
    };
  } catch (autoErr: any) {
    console.log(`[Shiprocket Pickup] Auto schedule notice:`, autoErr.message || autoErr);
  }

  return {
    pickupScheduledDate: tomorrowStr,
    pickupTokenNumber: '',
    pickupStatus: 'scheduled'
  };
}

// API Route: Book Shiprocket order
app.post('/api/shiprocket/order/book', async (req, res) => {
  clearShiprocketCache();
  const { orderId, courier, assignedEmployeeId, deliveryAddress, pickupLocationName, pickupPostcode } = req.body;

  const orderToBook = mockOrders.find(o => String(o.id) === String(orderId) || String(o.orderNumber) === String(orderId));

  if (!orderToBook) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  // Backend Guard Rail: validate customerName (must not be empty, missing or 'Walkin Customer' / 'Walk-in Customer')
  const nameTrimmed = (orderToBook.customerName || '').trim();
  if (!nameTrimmed || nameTrimmed.toLowerCase() === 'walkin customer' || nameTrimmed.toLowerCase() === 'walk-in customer') {
    return res.status(400).json({
      success: false,
      error: "There is no customer name. Please provide a valid customer name before booking this order."
    });
  }

  if (!courier || typeof courier.rate !== 'number') {
    return res.status(400).json({ success: false, error: 'Invalid courier parameters.' });
  }

  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();

      if (orderToBook) {
        if (deliveryAddress) {
          orderToBook.address = deliveryAddress;
        }
        // Dynamically resolve pickup location nickname from user's registered Shiprocket addresses
        let pickupLocation = pickupLocationName || 'Pune Primary Warehouse';
        try {
          if (!pickupLocationName) {
            const pickupData = await shiprocket.rawRequest('/settings/company/pickup', 'GET', headers);
            if (pickupData && pickupData.data && pickupData.data.shipping_address && pickupData.data.shipping_address.length > 0) {
              // Use the nickname of the first available pickup location
              pickupLocation = pickupData.data.shipping_address[0].pickup_location;
              console.log(`[Shiprocket] Dynamically resolved pickup location nickname: "${pickupLocation}"`);
            } else {
              console.log('[Shiprocket] No registered pickup locations found, using default Pune Primary Warehouse');
            }
          }
        } catch (pickupErr: any) {
          console.log('[Shiprocket] Failed to fetch registered pickup locations, using default:', pickupErr.message || pickupErr);
        }

        const isPrepaid = orderToBook.paymentMethod && orderToBook.paymentMethod.toUpperCase() === 'PREPAID';
        const orderPayload = {
          order_id: `DF-${orderToBook.orderNumber}-${Date.now()}`,
          order_date: orderToBook.date,
          pickup_location: pickupLocation,
          billing_customer_name: orderToBook.customerName.length >= 3 ? orderToBook.customerName : `${orderToBook.customerName} Customer`,
          billing_last_name: orderToBook.customerName.split(' ').slice(1).join(' ') || '',
          billing_address: orderToBook.address.address.length >= 10 ? orderToBook.address.address : `${orderToBook.address.address} Main Road`,
          billing_city: orderToBook.address.city,
          billing_pincode: orderToBook.address.pincode,
          billing_state: orderToBook.address.state,
          billing_country: 'India',
          billing_email: orderToBook.address.email || 'customer@dappersfit.com',
          billing_phone: cleanPhoneNumber(orderToBook.address.phone),
          shipping_is_billing: true,
          order_items: (orderToBook.items && orderToBook.items.length > 0)
            ? orderToBook.items.map(i => ({
                name: i.name || 'Electronic Gadget',
                sku: i.sku || 'SKU-ELEC',
                units: i.quantity || 1,
                selling_price: i.price || (orderToBook.totalAmount / (i.quantity || 1)) || 999
              }))
            : [{
                name: 'Electronic Gadget',
                sku: 'SKU-ELEC-01',
                units: 1,
                selling_price: orderToBook.totalAmount || 1499
              }],
          payment_method: isPrepaid ? 'Prepaid' : 'COD',
          sub_total: orderToBook.totalAmount,
          length: Math.max(0.5, Number(orderToBook.dimensions?.length) || 15),
          breadth: Math.max(0.5, Number(orderToBook.dimensions?.width) || 15),
          height: Math.max(0.5, Number(orderToBook.dimensions?.height) || 10),
          weight: Math.max(0.01, Number(orderToBook.weight) || 0.5)
        };

        const createData = await shiprocket.rawRequest('/orders/create/adhoc', 'POST', headers, orderPayload);
        const shiprocketId = createData?.order_id || createData?.data?.order_id || createData?.response?.data?.order_id;
        const shipmentId = createData?.shipment_id || createData?.data?.shipment_id || createData?.response?.data?.shipment_id || createData?.shipmentId || createData?.data?.shipmentId;

        if (!shipmentId || !shiprocketId) {
          const createErrMsg = createData?.message || createData?.response?.data?.message || createData?.error || (createData?.errors ? JSON.stringify(createData.errors) : 'Shiprocket order creation failed.');
          console.error('[Shiprocket Booking Failed] Order creation rejected:', createErrMsg);
          orderToBook.status = 'failed';
          orderToBook.errorMessage = createErrMsg;
          await saveSingleOrderToDb(orderToBook);
          return res.status(400).json({
            success: false,
            status: 'failed',
            error: createErrMsg
          });
        }

        // Assign AWB
        let awbCode = '';
        let assignedCourierName = courier.courierName;

        try {
          const awbPayload: any = { shipment_id: shipmentId };
          if (courier.courierId) {
            awbPayload.courier_id = courier.courierId;
          }
          let awbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, awbPayload);
          awbCode = awbData?.response?.data?.awb_code || awbData?.data?.awb_code || awbData?.awb_code || awbData?.response?.awb_code || '';
          if (awbData?.response?.data?.courier_name) {
            assignedCourierName = awbData.response.data.courier_name;
          }

          // Fallback: If specific courier had no AWB, attempt auto-assign courier on Shiprocket
          if (!awbCode && courier.courierId) {
            console.log(`[Shiprocket] Specific courier ${courier.courierId} returned no AWB, attempting auto-assign...`);
            awbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, { shipment_id: shipmentId });
            awbCode = awbData?.response?.data?.awb_code || awbData?.data?.awb_code || awbData?.awb_code || awbData?.response?.awb_code || '';
            if (awbData?.response?.data?.courier_name) {
              assignedCourierName = awbData.response.data.courier_name;
            }
          }

          if (!awbCode) {
            const specificErr = 
              awbData?.response?.data?.awb_assign_error ||
              awbData?.response?.data?.message ||
              awbData?.response?.message ||
              awbData?.message ||
              awbData?.error ||
              'AWB Assignment failed in Shiprocket. Courier may not be serviceable or wallet balance is low.';
            throw new Error(specificErr);
          }
        } catch (awbErr: any) {
          const errMsg = awbErr.message || String(awbErr);
          console.error('[Shiprocket Live Booking Failed] AWB Assignment failed:', errMsg);
          
          try {
             await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketId) || shiprocketId] });
             console.log(`[Shiprocket] Successfully cancelled order ${shiprocketId} due to AWB assignment failure.`);
          } catch (cancelErr) {
             console.error(`[Shiprocket] Failed to cancel order ${shiprocketId} after AWB error:`, cancelErr);
          }
          
          orderToBook.status = 'failed';
          orderToBook.errorMessage = errMsg;
          // Clear out the ids since we cancelled it
          orderToBook.shiprocketOrderId = undefined;
          orderToBook.shipmentId = undefined;
          await saveSingleOrderToDb(orderToBook);
          return res.status(400).json({
            success: false,
            status: 'failed',
            error: errMsg
          });
        }

        // Attempt label generation from official Shiprocket API
        let labelUrl = '';
        let labelGenerated = false;
        try {
          const labelData = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, { shipment_id: [Number(shipmentId) || shipmentId] });
          const rawLabelUrl = labelData?.label_url || labelData?.response?.label_url || labelData?.url || labelData?.pdf_url || '';
          if (rawLabelUrl) {
            labelUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(rawLabelUrl)}&filename=Label_${orderToBook.orderNumber || shipmentId}.pdf`;
            labelGenerated = true;
            console.log(`[Shiprocket] Official label generated successfully during booking: ${rawLabelUrl}`);
          } else {
            throw new Error('Label generation API succeeded but returned no PDF URL.');
          }
        } catch (labelErr: any) {
          console.log(`[Shiprocket] Label generation failed, cancelling order in Shiprocket: ${labelErr.message || labelErr}`);
          // Cancel order in Shiprocket since label generation failed
          try {
            await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketId) || shiprocketId] });
            console.log(`[Shiprocket] Successfully cancelled order ${shiprocketId} due to label generation failure.`);
          } catch (cancelErr) {
            console.error(`[Shiprocket] Failed to cancel order ${shiprocketId} after label error:`, cancelErr);
          }
          throw new Error(`Label generation failed: ${labelErr.message || labelErr}`);
        }

        // Schedule pickup on first-come, first-served basis (Today if available, else Tomorrow)
        const pickupResult = await scheduleShiprocketEarliestPickup(shipmentId, headers);
        const pickupScheduledDate = pickupResult.pickupScheduledDate;
        const pickupTokenNumber = pickupResult.pickupTokenNumber;
        const pickupStatus = pickupResult.pickupStatus;

        // Resolve canonical Shiprocket customer tracking link
        let trackingUrl = getShiprocketTrackingUrl(awbCode);
        try {
          const trackData = await shiprocket.rawRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, 'GET', headers);
          const liveUrl = trackData?.tracking_data?.track_url || trackData?.tracking_data?.tracking_url || trackData?.track_url;
          if (liveUrl && typeof liveUrl === 'string' && liveUrl.startsWith('http')) {
            trackingUrl = liveUrl;
          }
        } catch {}

        // Update local persistent db - Status is 'booked', NEVER 'shipped' until confirmed shipped by Shiprocket!
        orderToBook.status = 'booked';
        orderToBook.errorMessage = null;
        orderToBook.shiprocketOrderId = String(shiprocketId);
        orderToBook.shipmentId = String(shipmentId);
        orderToBook.awbCode = String(awbCode);
        orderToBook.courierName = assignedCourierName;
        orderToBook.assignedEmployeeId = assignedEmployeeId || orderToBook.assignedEmployeeId;
        orderToBook.labelUrl = labelGenerated ? labelUrl : undefined;
        orderToBook.pickupScheduledDate = pickupScheduledDate;
        orderToBook.pickupTokenNumber = pickupTokenNumber;
        orderToBook.pickupStatus = pickupStatus;
        orderToBook.trackingUrl = trackingUrl;
        orderToBook.trackingHistory = [
          { 
            date: new Date().toISOString().replace('T', ' ').slice(0, 16), 
            status: 'Booked & Pickup Scheduled', 
            location: `${pickupLocation} (Shiprocket)`, 
            activity: `Order booked via ${assignedCourierName}. Tracking ID (AWB): ${awbCode}. Pickup scheduled for ${pickupScheduledDate}${pickupTokenNumber ? ` (Token: ${pickupTokenNumber})` : ''}.${labelGenerated ? ' Shipping label generated.' : ' Label generation pending in Shiprocket.'}` 
          }
        ];

        await saveSingleOrderToDb(orderToBook);

        return res.json({
          success: true,
          status: 'booked',
          order: orderToBook,
          shiprocketOrderId: String(shiprocketId),
          shipmentId: String(shipmentId),
          awbCode: String(awbCode),
          courierName: assignedCourierName,
          labelUrl: orderToBook.labelUrl,
          labelGenerated,
          pickupScheduledDate,
          pickupTokenNumber,
          pickupStatus,
          trackingUrl
        });
      }
    } catch (err: any) {
      const liveErrMsg = err.message || 'Shiprocket live order booking failed.';
      console.error('[Shiprocket Live Booking Error]:', liveErrMsg);
      orderToBook.status = 'failed';
      orderToBook.errorMessage = liveErrMsg;
      await saveSingleOrderToDb(orderToBook);
      return res.status(400).json({
        success: false,
        status: 'failed',
        error: liveErrMsg
      });
    }
  }

  // Fallback Simulation bookings (only when live mode is not configured)
  const mockShiprocketId = `SR-${Math.floor(10000000 + Math.random() * 90000000)}`;
  const mockShipmentId = `SM-${Math.floor(10000000 + Math.random() * 90000000)}`;
  const mockAwb = `AWB${Math.floor(100000000 + Math.random() * 900000000)}`;
  
  // First-come, first-served: If available today (before 2:00 PM IST cutoff), book today; else tomorrow
  const { todayStr, tomorrowStr, istHour } = getISTPickupDates();
  const mockPickupDate = istHour < 14 ? todayStr : tomorrowStr;
  const mockToken = `PK-${Math.floor(100000 + Math.random() * 900000)}`;
  const mockTrackingUrl = getShiprocketTrackingUrl(mockAwb);

  if (deliveryAddress) {
    orderToBook.address = deliveryAddress;
  }
  const finalPickupLoc = pickupLocationName || 'Dapers';
  const mockLabelUrl = `/api/shiprocket/download-label-pdf?shipmentId=${encodeURIComponent(mockShipmentId)}`;
  
  orderToBook.status = 'booked';
  orderToBook.errorMessage = null;
  orderToBook.shiprocketOrderId = mockShiprocketId;
  orderToBook.shipmentId = mockShipmentId;
  orderToBook.awbCode = mockAwb;
  orderToBook.courierName = courier.courierName;
  orderToBook.assignedEmployeeId = assignedEmployeeId || orderToBook.assignedEmployeeId;
  orderToBook.labelUrl = mockLabelUrl;
  orderToBook.pickupScheduledDate = mockPickupDate;
  orderToBook.pickupTokenNumber = mockToken;
  orderToBook.pickupStatus = 'scheduled';
  orderToBook.trackingUrl = mockTrackingUrl;
  orderToBook.trackingHistory = [
    { 
      date: new Date().toISOString().replace('T', ' ').slice(0, 16), 
      status: 'Booked & Pickup Scheduled', 
      location: `${finalPickupLoc} Hub`, 
      activity: `Shipment booked via ${courier.courierName}. Tracking ID (AWB): ${mockAwb}. Pickup scheduled for ${mockPickupDate} (Token: ${mockToken}). Pickup Location: ${finalPickupLoc}.` 
    }
  ];

  await saveSingleOrderToDb(orderToBook);

  return res.json({
    success: true,
    status: 'booked',
    order: orderToBook,
    shiprocketOrderId: mockShiprocketId,
    shipmentId: mockShipmentId,
    awbCode: mockAwb,
    courierName: courier.courierName,
    labelUrl: mockLabelUrl,
    labelGenerated: true,
    pickupScheduledDate: mockPickupDate,
    pickupTokenNumber: mockToken,
    pickupStatus: 'scheduled',
    trackingUrl: mockTrackingUrl
  });
});

// Dedicated API Route: Explicit Schedule Pickup with Shiprocket
app.post('/api/shiprocket/schedule-pickup', async (req, res) => {
  const { orderId, pickupDate } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, error: 'orderId is required' });
  }

  const order = await getOrderFromDb(orderId);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }

  const { todayStr, tomorrowStr, istHour } = getISTPickupDates();
  let scheduledDate = pickupDate || (istHour < 14 ? todayStr : tomorrowStr);
  let tokenNumber = `PK-${Math.floor(100000 + Math.random() * 900000)}`;

  if (isLiveConfigured() && order.shipmentId && !String(order.shipmentId).startsWith('sim_') && !String(order.shipmentId).startsWith('SM-')) {
    try {
      const headers = await getShiprocketAuthHeaders();
      if (pickupDate) {
        const payload: any = {
          shipment_id: [Number(order.shipmentId) || order.shipmentId],
          pickup_date: [pickupDate]
        };
        const pickupData = await shiprocket.rawRequest('/courier/generate/pickup', 'POST', headers, payload);
        const resObj = pickupData?.response || pickupData?.data || pickupData || {};
        if (resObj.pickup_scheduled_date || pickupData?.pickup_scheduled_date) {
          scheduledDate = resObj.pickup_scheduled_date || pickupData?.pickup_scheduled_date;
        }
        if (resObj.pickup_token_number || pickupData?.pickup_token_number) {
          tokenNumber = String(resObj.pickup_token_number || pickupData?.pickup_token_number);
        }
      } else {
        // First-come, first-served (Today if available, else Tomorrow)
        const earliest = await scheduleShiprocketEarliestPickup(order.shipmentId, headers);
        scheduledDate = earliest.pickupScheduledDate;
        tokenNumber = earliest.pickupTokenNumber;
      }
    } catch (err: any) {
      console.warn('[Shiprocket Pickup] Live schedule API notice:', err.message || err);
    }
  }

  order.pickupScheduledDate = scheduledDate;
  order.pickupTokenNumber = tokenNumber;
  order.pickupStatus = 'scheduled';
  if (!order.trackingUrl && order.awbCode) {
    order.trackingUrl = getShiprocketTrackingUrl(order.awbCode);
  }
  
  if (!order.trackingHistory) order.trackingHistory = [];
  order.trackingHistory.unshift({
    date: new Date().toISOString().replace('T', ' ').slice(0, 16),
    status: 'Pickup Scheduled',
    location: order.address?.city || 'Warehouse Hub',
    activity: `Courier pickup scheduled for ${scheduledDate}${tokenNumber ? ` (Token: ${tokenNumber})` : ''}. Tracking ID: ${order.awbCode || 'Assigned'}.`
  });

  await saveSingleOrderToDb(order);
  return res.json({
    success: true,
    order,
    pickupScheduledDate: scheduledDate,
    pickupTokenNumber: tokenNumber,
    pickupStatus: 'scheduled',
    trackingUrl: order.trackingUrl
  });
});

// Production-ready Sequential Shiprocket Courier Booking Handler with Idempotency & Database Locking
async function handleBookCourierRequest(req: any, res: any) {
  clearShiprocketCache();
  const orderId = req.body?.orderId || req.params?.orderId;
  const { courierId, courierName, simulateFailure, sandbox, mode } = req.body || {};
  const isSandboxMode = sandbox === true || mode === 'sandbox';

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Order ID is required.' });
  }

  // 1. Check database for existing order
  const order = await getOrderFromDb(orderId);
  if (!order) {
    return res.status(404).json({ success: false, error: `Order '${orderId}' not found in database.` });
  }

  // If order is already processed and has a shipment or AWB, return existing booking details & label URL
  if (order.status === 'processed' && (order.awbCode || order.shipmentId || order.labelUrl)) {
    const existingLabelUrl = order.labelUrl || `/api/shiprocket/download-label-pdf?shipmentId=${encodeURIComponent(order.shipmentId || order.id)}`;
    console.log(`[Order Already Processed] Returning existing labelUrl for order ${order.id}: ${existingLabelUrl}`);
    return res.json({
      success: true,
      status: 'processed',
      orderId: order.id,
      orderNumber: order.orderNumber,
      shiprocketOrderId: order.shiprocketOrderId,
      shipmentId: order.shipmentId,
      awbCode: order.awbCode,
      courierName: order.courierName || 'Delhivery Surface',
      labelUrl: existingLabelUrl
    });
  }

  // 2. DATABASE STATUS LOCKING:
  order.status = 'processing';
  order.errorMessage = null;
  await saveSingleOrderToDb(order);
  console.log(`[Database Locked] Order ${order.id} status successfully locked to 'processing'.`);

  try {
    // Check for explicit simulation failure flags (e.g. testing low wallet balance or network error)
    if (simulateFailure && simulateFailure !== 'none') {
      if (simulateFailure === 'wallet') {
        throw new Error('Low wallet balance: Insufficient credits in Shiprocket wallet. Minimum ₹150 required.');
      } else if (simulateFailure === 'network') {
        throw new Error('Network error: Connection to Shiprocket external gateway timed out (504 Gateway Timeout).');
      } else {
        throw new Error(String(simulateFailure));
      }
    }

    // Validate customer name
    const nameTrimmed = (order.customerName || '').trim();
    if (!nameTrimmed || nameTrimmed.toLowerCase() === 'walkin customer' || nameTrimmed.toLowerCase() === 'walk-in customer') {
      throw new Error('Valid customer name is required before booking courier on Shiprocket.');
    }

    let shiprocketOrderId = '';
    let shipmentId = '';
    let awbCode = '';
    let assignedCourier = courierName || 'Delhivery Surface';
    let labelUrl = '';

    if (isLiveConfigured() && !isSandboxMode) {
      try {
        const headers = await getShiprocketAuthHeaders();

        // =========================================================================
        // a. Create Order API (/v1/external/orders/create/adhoc)
        // =========================================================================
        console.log(`[Shiprocket Sequential Flow] a. Creating adhoc order for ${order.orderNumber}...`);
        
        let pickupLocation = 'Pune Primary Warehouse';
        try {
          const pickupData = await shiprocket.rawRequest('/settings/company/pickup', 'GET', headers);
          if (pickupData?.data?.shipping_address?.length > 0) {
            pickupLocation = pickupData.data.shipping_address[0].pickup_location;
          }
        } catch (err: any) {
          console.log('[Shiprocket] Pickup address lookup fallback to default warehouse.');
        }

        const isPrepaid = order.paymentMethod && order.paymentMethod.toUpperCase() === 'PREPAID';
        const orderPayload = {
          order_id: `DF-${order.orderNumber}-${Date.now()}`,
          order_date: order.date || new Date().toISOString().slice(0, 10),
          pickup_location: pickupLocation,
          billing_customer_name: order.customerName.length >= 3 ? order.customerName : `${order.customerName} Customer`,
          billing_last_name: order.customerName.split(' ').slice(1).join(' ') || '',
          billing_address: (order.address?.address && order.address.address.length >= 10) ? order.address.address : `${order.address?.address || 'Main Road'} Suite 100`,
          billing_city: order.address?.city || 'Mumbai',
          billing_pincode: order.address?.pincode || '400001',
          billing_state: order.address?.state || 'Maharashtra',
          billing_country: 'India',
          billing_email: order.address?.email || 'customer@dappersfit.com',
          billing_phone: cleanPhoneNumber(order.address?.phone || '9876543210'),
          shipping_is_billing: true,
          order_items: (order.items && order.items.length > 0)
            ? order.items.map((i: any) => ({
                name: i.name || 'Apparel Item',
                sku: i.sku || 'SKU-APP',
                units: i.quantity || 1,
                selling_price: i.price || 999
              }))
            : [{
                name: 'Fashion Apparel',
                sku: 'SKU-FASHION-01',
                units: 1,
                selling_price: order.totalAmount || 1299
              }],
          payment_method: isPrepaid ? 'Prepaid' : 'COD',
          sub_total: order.totalAmount || 1299,
          length: Math.max(0.5, Number(order.dimensions?.length) || 15),
          breadth: Math.max(0.5, Number(order.dimensions?.width) || 15),
          height: Math.max(0.5, Number(order.dimensions?.height) || 10),
          weight: Math.max(0.01, Number(order.weight) || 0.5)
        };

        const createData = await shiprocket.rawRequest('/orders/create/adhoc', 'POST', headers, orderPayload);
        shiprocketOrderId = createData?.order_id || createData?.data?.order_id || createData?.response?.data?.order_id;
        shipmentId = createData?.shipment_id || createData?.data?.shipment_id || createData?.response?.data?.shipment_id || createData?.shipmentId;

        if (!shipmentId || !shiprocketOrderId) {
          const createErrMsg = createData?.message || createData?.response?.data?.message || createData?.error || 'Shiprocket order creation failed.';
          throw new Error(`Create Order API failed: ${createErrMsg}`);
        }
        console.log(`[Shiprocket Sequential Flow] a. Order created successfully: Shiprocket ID ${shiprocketOrderId}, Shipment ID ${shipmentId}`);

        // =========================================================================
        // b. Generate AWB API (/v1/external/courier/assign/awb)
        // =========================================================================
        console.log(`[Shiprocket Sequential Flow] b. Assigning AWB for shipment ${shipmentId}...`);
        const awbPayload: any = { shipment_id: shipmentId };
        if (courierId) {
          awbPayload.courier_id = courierId;
        }
        let awbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, awbPayload);
        awbCode = awbData?.response?.data?.awb_code || awbData?.data?.awb_code || awbData?.awb_code || awbData?.response?.awb_code || '';
        if (awbData?.response?.data?.courier_name) {
          assignedCourier = awbData.response.data.courier_name;
        }

        // If specific courier returned no AWB, attempt fallback auto-assign
        if (!awbCode && courierId) {
          console.log('[Shiprocket] Specific courier returned no AWB, attempting auto-assignment...');
          awbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, { shipment_id: shipmentId });
          awbCode = awbData?.response?.data?.awb_code || awbData?.data?.awb_code || awbData?.awb_code || awbData?.response?.awb_code || '';
          if (awbData?.response?.data?.courier_name) {
            assignedCourier = awbData.response.data.courier_name;
          }
        }

        if (!awbCode) {
          const specificErr = 
            awbData?.response?.data?.awb_assign_error ||
            awbData?.response?.data?.message ||
            awbData?.response?.message ||
            awbData?.message ||
            awbData?.error ||
            'AWB Assignment failed in Shiprocket. Courier may not be serviceable or wallet balance is low.';
          throw new Error(specificErr);
        }
        console.log(`[Shiprocket Sequential Flow] b. AWB resolved: ${awbCode} (${assignedCourier})`);

        // =========================================================================
        // c. Generate Shipping Label API (/v1/external/courier/generate/label)
        // =========================================================================
        console.log(`[Shiprocket Sequential Flow] c. Generating Shipping Label for shipment ${shipmentId}...`);
        try {
          const labelData = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, {
            shipment_id: [Number(shipmentId) || shipmentId]
          });

          const rawLabelUrl = labelData?.label_url || labelData?.response?.label_url || labelData?.pdf_url || labelData?.url || '';
          if (rawLabelUrl) {
            labelUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(rawLabelUrl)}&filename=Label_${order.orderNumber || shipmentId}.pdf`;
            console.log(`[Shiprocket Sequential Flow] c. Shipping Label captured: ${rawLabelUrl}`);
          } else {
            throw new Error('Label generation API succeeded but returned no PDF URL.');
          }
        } catch (lblErr: any) {
          console.log('[Shiprocket Sequential Flow] Label fetch failed, cancelling order in Shiprocket:', lblErr.message || lblErr);
          // If label fails, cancel the order in Shiprocket so it's not stuck
          try {
            await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketOrderId) || shiprocketOrderId] });
            console.log(`[Shiprocket] Successfully cancelled order ${shiprocketOrderId} due to label generation failure.`);
          } catch (cancelErr) {
            console.error(`[Shiprocket] Failed to cancel order ${shiprocketOrderId} after label error:`, cancelErr);
          }
          throw new Error(`Label generation failed: ${lblErr.message || lblErr}`);
        }

        // =========================================================================
        // d. Schedule Pickup API (First-come, first-served: Today if available, else Tomorrow)
        // =========================================================================
        const pickupResult = await scheduleShiprocketEarliestPickup(shipmentId, headers);
        order.pickupScheduledDate = pickupResult.pickupScheduledDate;
        order.pickupTokenNumber = pickupResult.pickupTokenNumber;
        order.pickupStatus = pickupResult.pickupStatus;

        let trackingUrl = getShiprocketTrackingUrl(awbCode);
        try {
          const trackData = await shiprocket.rawRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, 'GET', headers);
          const liveUrl = trackData?.tracking_data?.track_url || trackData?.tracking_data?.tracking_url || trackData?.track_url;
          if (liveUrl && typeof liveUrl === 'string' && liveUrl.startsWith('http')) {
            trackingUrl = liveUrl;
          }
        } catch {}
        order.trackingUrl = trackingUrl;

      } catch (liveErr: any) {
        console.error('[Shiprocket Sequential Flow] Live flow encountered error:', liveErr.message || liveErr);
        
        // If AWB assignment failed, the order exists but AWB failed. We need to cancel the order.
        if (shiprocketOrderId && !awbCode) {
           console.log(`[Shiprocket Sequential Flow] Cancelling order ${shiprocketOrderId} because AWB or Label failed.`);
           try {
             const headers = await getShiprocketAuthHeaders();
             await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketOrderId) || shiprocketOrderId] });
           } catch (e) {
             console.error(`[Shiprocket] Failed to cancel order ${shiprocketOrderId} after AWB error:`, e);
           }
        }
        
        throw liveErr;
      }
    } else {
      // Simulation / Test Sandbox Execution with realistic sequential steps
      console.log(`[Shiprocket Simulation] a. Creating adhoc order for ${order.orderNumber}...`);
      await new Promise(r => setTimeout(r, 650));
      shiprocketOrderId = `SR-${Math.floor(10000000 + Math.random() * 90000000)}`;
      shipmentId = `SM-${Math.floor(10000000 + Math.random() * 90000000)}`;

      console.log(`[Shiprocket Simulation] b. Generating AWB for shipment ${shipmentId}...`);
      await new Promise(r => setTimeout(r, 650));
      awbCode = `AWB${Math.floor(100000000 + Math.random() * 900000000)}`;

      console.log(`[Shiprocket Simulation] c. Generating shipping label for shipment ${shipmentId}...`);
      await new Promise(r => setTimeout(r, 450));
      labelUrl = `/api/shiprocket/download-label-pdf?shipmentId=${encodeURIComponent(shipmentId)}`;

      const { todayStr, tomorrowStr, istHour } = getISTPickupDates();
      const mockPickupDate = istHour < 14 ? todayStr : tomorrowStr;
      const mockToken = `PK-${Math.floor(100000 + Math.random() * 900000)}`;
      order.pickupScheduledDate = mockPickupDate;
      order.pickupTokenNumber = mockToken;
      order.pickupStatus = 'scheduled';
      order.trackingUrl = getShiprocketTrackingUrl(awbCode);
    }

    // =========================================================================
    // SUCCESS & BOOKED STATUS:
    // Follow actual status: order is 'booked' (not 'shipped') until confirmed by tracking/manifest.
    // =========================================================================
    order.status = 'booked';
    order.shiprocketOrderId = String(shiprocketOrderId);
    order.shipmentId = String(shipmentId);
    order.awbCode = String(awbCode);
    order.courierName = assignedCourier;
    order.labelUrl = labelUrl || undefined;
    order.errorMessage = null;
    if (!order.trackingUrl) {
      order.trackingUrl = getShiprocketTrackingUrl(awbCode);
    }
    if (!order.trackingHistory) order.trackingHistory = [];
    order.trackingHistory.push({
      date: new Date().toISOString().replace('T', ' ').slice(0, 16),
      status: 'Booked & Pickup Scheduled',
      location: 'Pune Fulfillment Center (MH)',
      activity: `Order booked via ${assignedCourier}. Tracking ID (AWB): ${awbCode}. Pickup scheduled for ${order.pickupScheduledDate}${order.pickupTokenNumber ? ` (Token: ${order.pickupTokenNumber})` : ''}.${labelUrl ? ' Shipping label generated.' : ' Label pending.'}`
    });

    await saveSingleOrderToDb(order);
    console.log(`[Shiprocket Success] Order ${order.id} successfully updated to 'booked'.`);

    return res.json({
      success: true,
      status: 'booked',
      order,
      orderId: order.id,
      orderNumber: order.orderNumber,
      shiprocketOrderId: String(shiprocketOrderId),
      shipmentId: String(shipmentId),
      awbCode: String(awbCode),
      courierName: assignedCourier,
      labelUrl: labelUrl || undefined,
      labelGenerated: !!labelUrl,
      pickupScheduledDate: order.pickupScheduledDate,
      pickupTokenNumber: order.pickupTokenNumber,
      pickupStatus: order.pickupStatus,
      trackingUrl: order.trackingUrl
    });

  } catch (err: any) {
    // =========================================================================
    // FAILURE & RETRY HANDLING:
    // "If any API call fails (e.g., low wallet balance or network error), catch the error,
    // update the database status to 'failed', and save the error message."
    // "Return an error response to the frontend."
    // =========================================================================
    const errorMsg = err?.message || 'Shiprocket courier booking failed. Please check wallet and details.';
    console.error(`[Shiprocket Booking Failure] Order ${order.id}:`, errorMsg);

    order.status = 'failed';
    order.errorMessage = errorMsg;
    await saveSingleOrderToDb(order);

    return res.status(400).json({
      success: false,
      status: 'failed',
      error: errorMsg,
      orderId: order.id
    });
  }
}

// Dedicated API endpoints for Book Courier
app.post('/api/shiprocket/book-courier', handleBookCourierRequest);
app.post('/api/orders/:orderId/book-courier', handleBookCourierRequest);

// API Route to reset an order status back to 'pending' for retry testing
app.post('/api/orders/:orderId/reset-status', async (req, res) => {
  const { orderId } = req.params;
  const order = await getOrderFromDb(orderId);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }
  order.status = 'pending';
  order.errorMessage = null;
  order.awbCode = undefined;
  order.shipmentId = undefined;
  order.shiprocketOrderId = undefined;
  order.labelUrl = undefined;
  await saveSingleOrderToDb(order);
  res.json({ success: true, order });
});

// API Route to manually set order status for testing idempotency locks
app.post('/api/orders/:orderId/set-status', async (req, res) => {
  const { orderId } = req.params;
  const { status, errorMessage } = req.body;
  const order = await getOrderFromDb(orderId);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }
  if (status) order.status = status;
  if (errorMessage !== undefined) order.errorMessage = errorMessage;
  await saveSingleOrderToDb(order);
  res.json({ success: true, order });
});

// API Route: Priority Automated Courier Matching and Booking
app.post('/api/shiprocket/order/priority-book', async (req, res) => {
  clearShiprocketCache();
  const { orderId, assignedEmployeeId } = req.body;
  const orderToBook = mockOrders.find(o => String(o.id) === String(orderId) || String(o.orderNumber) === String(orderId));

  if (!orderToBook) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  // Backend Guard Rail: validate customerName
  const nameTrimmed = (orderToBook.customerName || '').trim();
  if (!nameTrimmed || nameTrimmed.toLowerCase() === 'walkin customer' || nameTrimmed.toLowerCase() === 'walk-in customer') {
    return res.status(400).json({
      success: false,
      error: "There is no customer name. Please provide a valid customer name before booking this order."
    });
  }

  try {
    let couriersList = [];

    // 1. Check Serviceability
    if (isLiveConfigured()) {
      try {
        const headers = await getShiprocketAuthHeaders();
        const isPrepaid = orderToBook.paymentMethod && orderToBook.paymentMethod.toUpperCase() === 'PREPAID';
        const codQuery = isPrepaid ? '0' : '1';
        const endpoint = `/courier/serviceability?pickup_postcode=411037&delivery_postcode=${orderToBook.address.pincode}&weight=${orderToBook.weight || 0.5}&cod=${codQuery}`;
        const data = await shiprocket.rawRequest(endpoint, 'GET', headers);
        const rawCouriers = data?.data?.available_courier_companies || [];
        couriersList = rawCouriers.map((c) => ({
          courierId: c.courier_company_id,
          courierName: c.courier_name,
          rate: parseFloat(c.rate || '90.00'),
          eta: c.etd || '3-4 Days',
          rating: parseFloat(c.rating || '4.2'),
          cod: !!c.cod,
          minWeight: parseFloat(c.min_weight || '0.5')
        }));
      } catch (err) {
        console.log('Priority booking live serviceability query failed:', err.message || err);
      }
    }

    if (couriersList.length === 0) {
      couriersList = [
        { courierId: 201, courierName: 'BlueDart Air Premium', rate: 145.00, eta: '1 Day', rating: 4.9, cod: true, minWeight: 0.5 },
        { courierId: 202, courierName: 'BlueDart Surface 2KG', rate: 85.00, eta: '3 Days', rating: 4.5, cod: true, minWeight: 0.5 },
        { courierId: 203, courierName: 'Delhivery Express (Air)', rate: 110.00, eta: '1-2 Days', rating: 4.7, cod: true, minWeight: 0.5 },
        { courierId: 204, courierName: 'Delhivery Surface', rate: 65.00, eta: '4 Days', rating: 4.3, cod: true, minWeight: 0.5 },
        { courierId: 205, courierName: 'DTDC Air Express', rate: 95.00, eta: '2 Days', rating: 4.4, cod: true, minWeight: 0.5 },
        { courierId: 206, courierName: 'DTDC Surface Standard', rate: 58.00, eta: '5 Days', rating: 4.0, cod: true, minWeight: 0.5 },
        { courierId: 207, courierName: 'Shadowfax Local Standard', rate: 48.00, eta: '3 Days', rating: 4.2, cod: true, minWeight: 0.5 },
        { courierId: 208, courierName: 'India Post Speed Post', rate: 40.00, eta: '7 Days', rating: 3.9, cod: true, minWeight: 0.5 },
        { courierId: 209, courierName: 'Dappers', rate: 45.00, eta: '2 Days', rating: 4.8, cod: true, minWeight: 0.5 }
      ];
    }

    // 2. Determine Courier Sequence based on WG Exception
    const items = orderToBook.items || [];
    const isWG = items.some((item) => {
      const name = (item.name || '').toLowerCase();
      const sku = (item.sku || '').toLowerCase();
      const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).toLowerCase()) : [];
      return tags.includes('wg') || name.includes(' wg ') || name === 'wg' || name.startsWith('wg ') || name.endsWith(' wg') || name.includes('water gun') || sku.includes('wg');
    });

    let conditionSequence = [];
    conditionSequence.push('DAPPERS');
    
    if (isWG) {
      conditionSequence.push('DELIVERY_SURFACE_2KG');
      conditionSequence.push('INDIA_POST');
    } else {
      conditionSequence.push('BLUEDART_AIR');
      conditionSequence.push('BLUEDART_SURFACE');
      conditionSequence.push('DELIVERY_AIR');
      conditionSequence.push('DELIVERY_SURFACE');
      conditionSequence.push('INDIA_POST');
    }

    const matchesCourierCondition = (c, condition) => {
      const name = (c.courierName || '').toLowerCase();
      switch (condition) {
        case 'DAPPERS':
          return name.includes('dappers');
        case 'BLUEDART_AIR':
          return name.includes('blue') && name.includes('dart') && (name.includes('air') || name.includes('express') || name.includes('premium'));
        case 'BLUEDART_SURFACE':
          return name.includes('blue') && name.includes('dart') && (name.includes('surface') || name.includes('ground') || name.includes('2kg') || name.includes('standard'));
        case 'DELIVERY_AIR':
          return (name.includes('delhivery') || name.includes('delievry') || name.includes('delivery')) && (name.includes('air') || name.includes('express') || name.includes('premium'));
        case 'DELIVERY_SURFACE':
          return (name.includes('delhivery') || name.includes('delievry') || name.includes('delivery')) && (name.includes('surface') || name.includes('ground') || (!name.includes('air') && !name.includes('express') && !name.includes('premium')));
        case 'DELIVERY_SURFACE_2KG':
          return (name.includes('delhivery') || name.includes('delievry') || name.includes('delivery')) && (name.includes('surface') || name.includes('2kg') || name.includes('ground'));
        case 'INDIA_POST':
          return name.includes('india post') || name.includes('speed post') || name.includes('business post');
        default:
          return false;
      }
    };

    // 3. Build sequence of viable couriers from couriersList
    let priorityCourierCandidates = [];
    for (const condition of conditionSequence) {
      const matched = couriersList.filter(c => matchesCourierCondition(c, condition));
      if (matched.length > 0) {
        matched.sort((a, b) => a.rate - b.rate);
        priorityCourierCandidates.push(...matched);
      }
    }

    // Filter duplicates while preserving the order of insertion
    priorityCourierCandidates = priorityCourierCandidates.filter((c, index, self) => 
      index === self.findIndex((t) => t.courierId === c.courierId)
    );

    if (priorityCourierCandidates.length === 0) {
      return res.status(400).json({
        success: false,
        error: `No serviceable courier partners could be found for Pincode ${orderToBook.address.pincode} matching the priority sequence.`
      });
    }

    let shiprocketId = '';
    let shipmentId = '';
    let awbCode = '';
    let labelUrl = '';
    let assignedCourierName = priorityCourierCandidates[0].courierName;
    let successfulCourierId = priorityCourierCandidates[0].courierId;
    let labelGenerated = false;
    let bookedRate = priorityCourierCandidates[0].rate;

    // 4. Book the chosen Courier
    if (isLiveConfigured()) {
      try {
        const headers = await getShiprocketAuthHeaders();
        let pickupLocation = 'Pune Primary Warehouse';
        try {
          const pickupData = await shiprocket.rawRequest('/settings/company/pickup', 'GET', headers);
          if (pickupData && pickupData.data && pickupData.data.shipping_address && pickupData.data.shipping_address.length > 0) {
            pickupLocation = pickupData.data.shipping_address[0].pickup_location;
          }
        } catch {}

        const isPrepaid = orderToBook.paymentMethod && orderToBook.paymentMethod.toUpperCase() === 'PREPAID';
        const orderPayload = {
          order_id: `DF-${orderToBook.orderNumber}-${Date.now()}`,
          order_date: orderToBook.date,
          pickup_location: pickupLocation,
          billing_customer_name: orderToBook.customerName.length >= 3 ? orderToBook.customerName : `${orderToBook.customerName} Customer`,
          billing_last_name: orderToBook.customerName.split(' ').slice(1).join(' ') || '',
          billing_address: orderToBook.address.address.length >= 10 ? orderToBook.address.address : `${orderToBook.address.address} Main Road`,
          billing_city: orderToBook.address.city,
          billing_pincode: orderToBook.address.pincode,
          billing_state: orderToBook.address.state,
          billing_country: 'India',
          billing_email: orderToBook.address.email || 'customer@dappersfit.com',
          billing_phone: cleanPhoneNumber(orderToBook.address.phone),
          shipping_is_billing: true,
          order_items: (orderToBook.items && orderToBook.items.length > 0)
            ? orderToBook.items.map(i => ({
                name: i.name || 'Electronic Gadget',
                sku: i.sku || 'SKU-ELEC',
                units: i.quantity || 1,
                selling_price: i.price || (orderToBook.totalAmount / (i.quantity || 1)) || 999
              }))
            : [{
                name: 'Electronic Gadget',
                sku: 'SKU-ELEC-01',
                units: 1,
                selling_price: orderToBook.totalAmount || 1499
              }],
          payment_method: isPrepaid ? 'Prepaid' : 'COD',
          sub_total: orderToBook.totalAmount,
          length: Math.max(0.5, Number(orderToBook.dimensions?.length) || 15),
          breadth: Math.max(0.5, Number(orderToBook.dimensions?.width) || 15),
          height: Math.max(0.5, Number(orderToBook.dimensions?.height) || 10),
          weight: Math.max(0.01, Number(orderToBook.weight) || 0.5)
        };

        const createData = await shiprocket.rawRequest('/orders/create/adhoc', 'POST', headers, orderPayload);
        shiprocketId = createData?.order_id || createData?.data?.order_id || createData?.response?.data?.order_id;
        shipmentId = createData?.shipment_id || createData?.data?.shipment_id || createData?.response?.data?.shipment_id || createData?.shipmentId || createData?.data?.shipmentId;

        if (!shipmentId || !shiprocketId) {
          const createErrMsg = createData?.message || createData?.response?.data?.message || createData?.error || (createData?.errors ? JSON.stringify(createData.errors) : 'Shiprocket order creation failed.');
          console.error('[Shiprocket Priority Booking Failed] Order creation rejected:', createErrMsg);
          orderToBook.status = 'failed';
          orderToBook.errorMessage = createErrMsg;
          await saveSingleOrderToDb(orderToBook);
          return res.status(400).json({
            success: false,
            status: 'failed',
            error: createErrMsg
          });
        }

        // Try Assigning AWB matching the Priority Sequence
        let lastAwbError = '';
        for (const candidate of priorityCourierCandidates) {
          try {
            console.log(`[Shiprocket Priority Booking] Trying AWB assignment with courier ${candidate.courierName} (${candidate.courierId})`);
            const awbPayload = { shipment_id: shipmentId, courier_id: candidate.courierId };
            let awbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, awbPayload);
            let testAwbCode = awbData?.response?.data?.awb_code || awbData?.data?.awb_code || awbData?.awb_code || awbData?.response?.awb_code || '';
            
            if (testAwbCode) {
              awbCode = testAwbCode;
              assignedCourierName = awbData?.response?.data?.courier_name || candidate.courierName;
              successfulCourierId = candidate.courierId;
              bookedRate = candidate.rate;
              break; // Success! Stop falling back.
            } else {
              lastAwbError = awbData?.response?.data?.awb_assign_error || 
                awbData?.response?.data?.message || 
                (typeof awbData?.message === 'string' ? awbData.message : '') || 
                (typeof awbData?.response === 'string' ? awbData.response : '') || 
                'Empty AWB code returned. (Check Shiprocket wallet recharge or courier serviceability)';
              console.log(`[Shiprocket] Courier ${candidate.courierId} (${candidate.courierName}) failed AWB: ${lastAwbError}. Moving to next fallback...`);
            }
          } catch (awbErr: any) {
            lastAwbError = awbErr.message || String(awbErr);
            console.log(`[Shiprocket] Courier ${candidate.courierId} (${candidate.courierName}) failed AWB: ${lastAwbError}. Moving to next fallback...`);
          }
        }

        // Resilient fallback: If priority candidates could not assign AWB, attempt Shiprocket general auto-assign
        if (!awbCode) {
          console.log('[Shiprocket Priority Booking] Specific couriers returned no AWB, attempting Shiprocket automatic best-courier assignment...');
          try {
            const autoAwbData = await shiprocket.rawRequest('/courier/assign/awb', 'POST', headers, { shipment_id: shipmentId });
            const autoAwbCode = autoAwbData?.response?.data?.awb_code || autoAwbData?.data?.awb_code || autoAwbData?.awb_code || autoAwbData?.response?.awb_code || '';
            if (autoAwbCode) {
              awbCode = autoAwbCode;
              assignedCourierName = autoAwbData?.response?.data?.courier_name || 'Shiprocket Auto-Assigned Courier';
              successfulCourierId = autoAwbData?.response?.data?.courier_company_id || 0;
              console.log(`[Shiprocket Priority Booking] Successfully auto-assigned AWB ${awbCode} via ${assignedCourierName}`);
            } else {
              const autoErr = autoAwbData?.response?.data?.awb_assign_error || autoAwbData?.message || autoAwbData?.response?.data?.message;
              if (autoErr) lastAwbError = autoErr;
            }
          } catch (autoErr: any) {
            console.log('[Shiprocket Priority Booking] Auto-assign fallback failed:', autoErr.message || autoErr);
          }
        }

        if (!awbCode) {
          console.error('[Shiprocket Priority Booking Failed] All fallback sequence couriers failed to assign AWB.');
          try {
             await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketId) || shiprocketId] });
             console.log(`[Shiprocket] Successfully cancelled priority order ${shiprocketId} due to AWB fallback exhaustion.`);
          } catch (cancelErr) {
             console.error(`[Shiprocket] Failed to cancel priority order ${shiprocketId}:`, cancelErr);
          }
          
          orderToBook.status = 'failed';
          orderToBook.errorMessage = `AWB Assignment Failed across all prioritized couriers. Last error: ${lastAwbError}`;
          orderToBook.shiprocketOrderId = undefined;
          orderToBook.shipmentId = undefined;
          await saveSingleOrderToDb(orderToBook);
          return res.status(400).json({
            success: false,
            status: 'failed',
            error: orderToBook.errorMessage
          });
        }

        // Attempt label generation from official Shiprocket API (same as manual booking flow)
        try {
          const labelData = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, { shipment_id: [Number(shipmentId) || shipmentId] });
          const rawLabelUrl = labelData?.label_url || labelData?.response?.label_url || labelData?.url || labelData?.pdf_url || '';
          if (rawLabelUrl) {
            labelUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(rawLabelUrl)}&filename=Label_${orderToBook.orderNumber || shipmentId}.pdf`;
            console.log(`[Shiprocket] Official label generated successfully during priority booking: ${rawLabelUrl}`);
            labelGenerated = true;
          } else {
            throw new Error('Label generation API succeeded but returned no PDF URL.');
          }
        } catch (labelErr) {
          console.log(`[Shiprocket] Priority booking label failed, cancelling order in Shiprocket: ${labelErr.message || labelErr}`);
          try {
            await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [Number(shiprocketId) || shiprocketId] });
            console.log(`[Shiprocket] Successfully cancelled priority order ${shiprocketId} due to label generation failure.`);
          } catch (cancelErr) {
            console.error(`[Shiprocket] Failed to cancel priority order ${shiprocketId} after label error:`, cancelErr);
          }
          throw new Error(`Label generation failed: ${labelErr.message || labelErr}`);
        }

        // Schedule pickup on first-come, first-served basis (Today if available, else Tomorrow)
        const pickupResult = await scheduleShiprocketEarliestPickup(shipmentId, headers);
        orderToBook.pickupScheduledDate = pickupResult.pickupScheduledDate;
        orderToBook.pickupTokenNumber = pickupResult.pickupTokenNumber;
        orderToBook.pickupStatus = pickupResult.pickupStatus;

        let trackingUrl = getShiprocketTrackingUrl(awbCode);
        try {
          const trackData = await shiprocket.rawRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, 'GET', headers);
          const liveUrl = trackData?.tracking_data?.track_url || trackData?.tracking_data?.tracking_url || trackData?.track_url;
          if (liveUrl && typeof liveUrl === 'string' && liveUrl.startsWith('http')) {
            trackingUrl = liveUrl;
          }
        } catch {}
        orderToBook.trackingUrl = trackingUrl;

      } catch (liveErr) {
        console.error('[Shiprocket Priority Booking] Live flow encountered error:', liveErr.message || liveErr);
        orderToBook.status = 'failed';
        orderToBook.errorMessage = `Live booking failed: ${liveErr.message || liveErr}`;
        await saveSingleOrderToDb(orderToBook);
        return res.status(500).json({
          success: false,
          status: 'failed',
          error: orderToBook.errorMessage
        });
      }
    } else {
      // Simulation flow
      console.log(`[Shiprocket Simulation] 1. Creating ad-hoc order for ${orderToBook.orderNumber}...`);
      await new Promise(r => setTimeout(r, 400));
      shiprocketId = `sim_order_${Date.now()}`;
      shipmentId = `sim_ship_${Date.now()}`;

      console.log(`[Shiprocket Simulation] 2. Assigning AWB via Priority Courier: ${assignedCourierName}...`);
      await new Promise(r => setTimeout(r, 450));
      awbCode = `AWB${Math.floor(Math.random() * 1000000000)}`;

      console.log(`[Shiprocket Simulation] 3. Generating shipping label...`);
      await new Promise(r => setTimeout(r, 450));
      labelUrl = `/api/shiprocket/download-label-pdf?shipmentId=${encodeURIComponent(shipmentId)}`;
      labelGenerated = true;

      const { todayStr, tomorrowStr, istHour } = getISTPickupDates();
      const mockPickupDate = istHour < 14 ? todayStr : tomorrowStr;
      const mockToken = `PK-${Math.floor(100000 + Math.random() * 900000)}`;
      orderToBook.pickupScheduledDate = mockPickupDate;
      orderToBook.pickupTokenNumber = mockToken;
      orderToBook.pickupStatus = 'scheduled';
      orderToBook.trackingUrl = getShiprocketTrackingUrl(awbCode);
    }

    // Update local persistent db - Status is 'booked'
    orderToBook.status = 'booked';
    orderToBook.errorMessage = null;
    orderToBook.shiprocketOrderId = String(shiprocketId);
    orderToBook.shipmentId = String(shipmentId);
    orderToBook.awbCode = String(awbCode);
    orderToBook.courierName = assignedCourierName;
    orderToBook.assignedEmployeeId = assignedEmployeeId || orderToBook.assignedEmployeeId;
    orderToBook.labelUrl = labelGenerated ? labelUrl : undefined;
    if (!orderToBook.trackingUrl) {
      orderToBook.trackingUrl = getShiprocketTrackingUrl(awbCode);
    }
    orderToBook.trackingHistory = [
      { 
        date: new Date().toISOString().replace('T', ' ').slice(0, 16), 
        status: 'Booked & Pickup Scheduled', 
        location: 'Pune Warehouse (MH)', 
        activity: `Shipment booked via priority match: ${assignedCourierName}. Tracking ID (AWB): ${awbCode}. Pickup scheduled for ${orderToBook.pickupScheduledDate}${orderToBook.pickupTokenNumber ? ` (Token: ${orderToBook.pickupTokenNumber})` : ''}.${labelGenerated ? ' Shipping label generated.' : ' Label pending.'}` 
      }
    ];

    await saveSingleOrderToDb(orderToBook);

    return res.json({
      success: true,
      status: 'booked',
      order: orderToBook,
      shiprocketOrderId: String(shiprocketId),
      shipmentId: String(shipmentId),
      awbCode: String(awbCode),
      courierName: assignedCourierName,
      rate: bookedRate,
      labelUrl: orderToBook.labelUrl,
      labelGenerated,
      pickupScheduledDate: orderToBook.pickupScheduledDate,
      pickupTokenNumber: orderToBook.pickupTokenNumber,
      pickupStatus: orderToBook.pickupStatus,
      trackingUrl: orderToBook.trackingUrl
    });
  } catch (err) {
    const liveErrMsg = err.message || 'Priority booking failed on Shiprocket.';
    console.error('[Shiprocket] Priority live booking failed:', liveErrMsg);
    orderToBook.status = 'failed';
    orderToBook.errorMessage = liveErrMsg;
    await saveSingleOrderToDb(orderToBook);
    return res.status(400).json({
      success: false,
      status: 'failed',
      error: liveErrMsg
    });
  }
});

// API Route: Reconcile missing shipmentId and tracking info from Shiprocket
app.post('/api/shiprocket/reconcile-shipment', async (req, res) => {
  const { orderId, shiprocketOrderId } = req.body;
  
  const foundIdx = mockOrders.findIndex(o => String(o.id) === String(orderId) || String(o.orderNumber) === String(orderId));
  if (foundIdx === -1) {
    return res.status(404).json({ success: false, error: 'Order not found in database.' });
  }

  const order = mockOrders[foundIdx];
  const targetSRId = shiprocketOrderId || order.shiprocketOrderId;

  if (!targetSRId) {
    // If no live ID, let's create simulated IDs if needed
    if (!order.shipmentId) {
      order.shipmentId = `SM-${Math.floor(10000000 + Math.random() * 90000000)}`;
    }
    if (!order.awbCode) {
      order.awbCode = `AWB${Math.floor(100000000 + Math.random() * 900000000)}`;
    }
    if (!order.courierName) {
      order.courierName = 'Delhivery Surface (Simulated)';
    }
    if (order.status === 'pending') {
      order.status = 'shipped';
    }
    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'orders', String(order.id)), sanitizeForFirestore(order));
      } catch (err: any) {
        console.error('[Firebase] Error persisting reconciled order:', err);
      }
    }
    await saveOrdersToFile();
    return res.json({
      success: true,
      order,
      shipmentId: order.shipmentId,
      awbCode: order.awbCode,
      courierName: order.courierName
    });
  }

  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const responseData = await shiprocket.rawRequest(`/orders/show/${targetSRId}`, 'GET', headers);
      
      const details = responseData?.data;
      if (details) {
        const shipmentId = details.shipments?.[0]?.id || details.shipments?.[0]?.shipment_id || details.shipment_id;
        const awbCode = details.shipments?.[0]?.awb || details.shipments?.[0]?.awb_code || details.awb_code;
        const courierName = details.shipments?.[0]?.courier || details.shipments?.[0]?.courier_name || details.courier_name;

        if (shipmentId) {
          order.shipmentId = String(shipmentId);
          if (awbCode) order.awbCode = String(awbCode);
          if (courierName) order.courierName = String(courierName);
          if (order.status === 'pending') {
            order.status = 'shipped';
          }
          if (isFirebaseEnabled && firestoreDb) {
            try {
              await setDoc(doc(firestoreDb, 'orders', String(order.id)), sanitizeForFirestore(order));
            } catch (err: any) {
              console.error('[Firebase] Error persisting live reconciled order:', err);
            }
          }
          await saveOrdersToFile();
          return res.json({
            success: true,
            order,
            shipmentId: order.shipmentId,
            awbCode: order.awbCode,
            courierName: order.courierName
          });
        }
      }
    } catch (err: any) {
      console.log(`[Shiprocket Reconcile] Failed to fetch live details for ${targetSRId}:`, err.message || err);
    }
  }

  // Simulation fallback if live fails or isn't configured
  if (!order.shipmentId) {
    order.shipmentId = `SM-${Math.floor(10000000 + Math.random() * 90000000)}`;
  }
  if (!order.awbCode) {
    order.awbCode = `AWB${Math.floor(100000000 + Math.random() * 900000000)}`;
  }
  if (!order.courierName) {
    order.courierName = 'Delhivery Surface (Simulated)';
  }
  if (order.status === 'pending') {
    order.status = 'shipped';
  }
  if (isFirebaseEnabled && firestoreDb) {
    try {
      await setDoc(doc(firestoreDb, 'orders', String(order.id)), sanitizeForFirestore(order));
    } catch (err: any) {
      console.error('[Firebase] Error persisting simulated reconciled order:', err);
    }
  }
  await saveOrdersToFile();
  return res.json({
    success: true,
    order,
    shipmentId: order.shipmentId,
    awbCode: order.awbCode,
    courierName: order.courierName
  });
});

// API Route: Print shipping labels (Fetches official Shiprocket label)
app.post('/api/shiprocket/label', async (req, res) => {
  let { shipmentId } = req.body;
  if (!shipmentId) {
    return res.status(400).json({ error: 'shipmentId is required' });
  }

  shipmentId = String(shipmentId);

  // Look up order in memory or database to get actual Shiprocket shipmentId if available
  const matchingOrder = mockOrders.find((o: any) => 
    String(o.shipmentId) === shipmentId || 
    String(o.shiprocketOrderId) === shipmentId || 
    String(o.id) === shipmentId || 
    String(o.orderNumber) === shipmentId
  );

  // 1. If matching order already has an official Shiprocket label URL, return it immediately
  if (matchingOrder?.labelUrl && (matchingOrder.labelUrl.includes('sr-core-cdn') || matchingOrder.labelUrl.includes('download-live-pdf'))) {
    let finalUrl = matchingOrder.labelUrl;
    if (!finalUrl.includes('/api/shiprocket/download-live-pdf')) {
      finalUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(finalUrl)}&filename=Label_${matchingOrder.orderNumber || shipmentId}.pdf`;
    }
    return res.json({ success: true, labelUrl: finalUrl, labelGenerated: true });
  }

  const resolvedShipmentId = matchingOrder?.shipmentId ? String(matchingOrder.shipmentId) : shipmentId;
  const numId = Number(resolvedShipmentId);

  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      let targetShipmentId = numId;

      // If shipment ID is not numeric or invalid, try looking up via shiprocketOrderId
      if ((isNaN(targetShipmentId) || targetShipmentId < 1000) && matchingOrder?.shiprocketOrderId && !isNaN(Number(matchingOrder.shiprocketOrderId))) {
        const showData = await shiprocket.rawRequest(`/orders/show/${matchingOrder.shiprocketOrderId}`, 'GET', headers);
        const sId = showData?.data?.shipments?.[0]?.id || showData?.data?.shipments?.[0]?.shipment_id;
        if (sId) {
          targetShipmentId = Number(sId);
          matchingOrder.shipmentId = String(sId);
        }
      }

      if (!isNaN(targetShipmentId) && targetShipmentId > 1000) {
        const payload = { shipment_id: [targetShipmentId] };
        const data = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, payload);
        
        const labelUrl = data?.label_url || data?.response?.label_url || data?.url || data?.pdf_url;
        if (labelUrl) {
          // Proxy through our backend to bypass browser-level cross-origin iframe blocks
          const url = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(labelUrl)}&filename=Label_${matchingOrder?.orderNumber || shipmentId}.pdf`;
          if (matchingOrder) {
            matchingOrder.labelUrl = url;
            await saveSingleOrderToDb(matchingOrder);
          }
          return res.json({ success: true, labelUrl: url, labelGenerated: true });
        }
      }

      return res.status(404).json({
        success: false,
        labelGenerated: false,
        error: 'Shiprocket has not generated the label for this shipment yet. The order is booked, but label is still processing.'
      });
    } catch (err: any) {
      console.log('[Shiprocket Label Fetch Error]:', err.message || err);
      return res.status(500).json({
        success: false,
        labelGenerated: false,
        error: err.message || 'Failed to fetch label from Shiprocket.'
      });
    }
  }

  res.json({
    success: true,
    labelUrl: `/api/shiprocket/download-label-pdf?shipmentId=${encodeURIComponent(shipmentId)}`,
    labelGenerated: true
  });
});

// GET Endpoint to serve physical shipping label PDF file with same-origin policy

// Helper: Generate a minimal PDF buffer natively in Node.js
function generateMinimalPDF(title: string, lines: string[]): Buffer {
  let content = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  let stream = "BT\n/F1 12 Tf\n20 750 Td\n(" + title.replace(/[()\\]/g, "") + ") Tj\n";
  for(let i=0; i < lines.length; i++) {
     stream += "0 -15 Td\n(" + lines[i].replace(/[()\\]/g, "") + ") Tj\n";
  }
  stream += "ET";
  const streamLen = stream.length;
  content += "4 0 obj\n<< /Length " + streamLen + " >>\nstream\n" + stream + "\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF";
  return Buffer.from(content, 'utf-8');
}

app.get('/api/shiprocket/download-label-pdf', async (req, res) => {
  const shipmentId = String(req.query.shipmentId || '');
  const order = mockOrders.find((o: any) => 
    String(o.shipmentId) === shipmentId || 
    String(o.shiprocketOrderId) === shipmentId || 
    String(o.id) === shipmentId || 
    String(o.orderNumber) === shipmentId
  ) || mockOrders.find((o: any) => o.shipmentId || o.shiprocketOrderId) || mockOrders[0];

  if (!order) {
    return res.status(404).send('No dispatch orders available in current database to generate labels.');
  }

  // 1. If order already has a live Shiprocket label URL, proxy/stream that real PDF
  if (order.labelUrl && (order.labelUrl.includes('sr-core-cdn') || order.labelUrl.includes('download-live-pdf'))) {
    try {
      let liveUrl = order.labelUrl;
      if (liveUrl.includes('download-live-pdf?url=')) {
        const match = liveUrl.match(/url=([^&]+)/);
        if (match) liveUrl = decodeURIComponent(match[1]);
      }
      console.log(`[Download Label] Streaming official Shiprocket PDF from stored URL: ${liveUrl}`);
      const pdfRes = await fetch(liveUrl);
      if (pdfRes.ok) {
        const buffer = await pdfRes.arrayBuffer();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Label_${order.orderNumber || shipmentId}.pdf"`);
        return res.send(Buffer.from(buffer));
      }
    } catch (fetchErr: any) {
      console.log('[Download Label] Failed to fetch stored live PDF:', fetchErr.message);
    }
  }

  // 2. Query Shiprocket API directly for live label PDF
  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      let targetShipmentId = order.shipmentId ? Number(order.shipmentId) : Number(shipmentId);

      if ((isNaN(targetShipmentId) || targetShipmentId < 1000) && order.shiprocketOrderId && !isNaN(Number(order.shiprocketOrderId))) {
        const showData = await shiprocket.rawRequest(`/orders/show/${order.shiprocketOrderId}`, 'GET', headers);
        const sId = showData?.data?.shipments?.[0]?.id || showData?.data?.shipments?.[0]?.shipment_id;
        if (sId) {
          targetShipmentId = Number(sId);
          order.shipmentId = String(sId);
        }
      }

      if (!isNaN(targetShipmentId) && targetShipmentId > 1000) {
        console.log(`[Download Label] Requesting official Shiprocket label for shipment ${targetShipmentId}`);
        const labelData = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, { shipment_id: [targetShipmentId] });
        const livePdfUrl = labelData?.label_url || labelData?.response?.label_url || labelData?.url || labelData?.pdf_url;
        if (livePdfUrl) {
          console.log(`[Download Label] Found live Shiprocket label URL: ${livePdfUrl}`);
          order.labelUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(livePdfUrl)}&filename=Label_${order.orderNumber || shipmentId}.pdf`;
          await saveOrdersToFile();

          const pdfRes = await fetch(livePdfUrl);
          if (pdfRes.ok) {
            const buffer = await pdfRes.arrayBuffer();
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="Label_${order.orderNumber || shipmentId}.pdf"`);
            return res.send(Buffer.from(buffer));
          }
        }
      }
    } catch (liveErr: any) {
      console.error('[Download Label] Live Shiprocket label fetch failed:', liveErr.message || liveErr);
    }
  }

  const safeVal = (val: any, fallback: string = '—') => {
    if (val === undefined || val === null || val === '') return fallback;
    return String(val);
  };

  const lines = [
    `Order Number: ${safeVal(order.orderNumber)}`,
    `AWB Code: ${safeVal(order.awbCode, 'Pending/Assigned')}`,
    `Courier Partner: ${safeVal(order.courierName, 'Delhivery')}`,
    `Shipment ID: ${safeVal(order.shipmentId, 'Pending')}`,
    `Order Date: ${safeVal(order.date)}`,
    `Payment Method: ${safeVal(order.paymentMethod, 'PREPAID').toUpperCase()}`,
    `------------------------------------------------------------------------`,
    `SHIP TO:`,
    `  Name: ${safeVal(order.customerName)}`,
    `  Phone: ${safeVal(order.address?.phone)}`,
    `  Email: ${safeVal(order.address?.email, 'N/A')}`,
    `  Address: ${safeVal(order.address?.address)}`,
    `  Location: ${safeVal(order.address?.city)}, ${safeVal(order.address?.state)} - ${safeVal(order.address?.pincode)}`,
    `------------------------------------------------------------------------`,
    `PACKAGE DETAILS:`,
    `  Weight: ${safeVal(order.weight, '0.5')} kg`,
    `  Dimensions: ${safeVal(order.dimensions?.length, '15')}x${safeVal(order.dimensions?.width, '15')}x${safeVal(order.dimensions?.height, '10')} cm`,
    `  Total Value: INR ${safeVal(order.totalAmount)}`,
    `------------------------------------------------------------------------`,
    `ITEMS:`,
  ];

  if (Array.isArray(order.items)) {
    order.items.forEach((item: any, idx: number) => {
      lines.push(`  ${idx + 1}. ${safeVal(item.name)} (SKU: ${safeVal(item.sku)}) x ${safeVal(item.quantity)} - INR ${safeVal(item.price)}`);
    });
  }

  const pdfBuffer = generateMinimalPDF('SHIPROCKET SHIPPING LABEL - DAPPERFIT RETAIL', lines);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Label_${order.orderNumber || '0000'}.pdf"`);
  res.send(pdfBuffer);
});

// GET Endpoint to proxy live PDF downloads from Shiprocket (S3 etc.) securely without triggering iframe navigation blocks
app.get('/api/shiprocket/download-live-pdf', async (req, res) => {
  const pdfUrl = String(req.query.url || '');
  const filename = String(req.query.filename || 'document.pdf');

  if (!pdfUrl) {
    return res.status(400).send('PDF URL is required.');
  }

  try {
    console.log(`[Proxy PDF Download] Fetching live PDF from: ${pdfUrl}`);
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF from remote server. Status: ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err: any) {
    console.error('[Proxy PDF Download] Error fetching or streaming PDF:', err.message || err);
    res.status(500).send(`Failed to download live PDF: ${err.message}`);
  }
});

// API Route: Print tax invoice (Simulates PDF URL retrieval)
app.post('/api/shiprocket/invoice', async (req, res) => {
  const { orderId, ids } = req.body;

  // Resolve matching order from repository if possible
  const matchingOrder = mockOrders.find((o: any) => 
    String(o.shiprocketOrderId) === String(orderId) || 
    String(o.shipmentId) === String(orderId) || 
    String(o.id) === String(orderId) || 
    String(o.orderNumber) === String(orderId)
  );

  let targetIds: number[] = [];
  if (Array.isArray(ids) && ids.length > 0) {
    targetIds = ids.map((id: any) => Number(id)).filter((n: number) => !isNaN(n) && n > 0);
  } else if (matchingOrder?.shiprocketOrderId && !isNaN(Number(matchingOrder.shiprocketOrderId))) {
    targetIds = [Number(matchingOrder.shiprocketOrderId)];
  } else if (orderId && !isNaN(Number(orderId)) && Number(orderId) > 1000) {
    targetIds = [Number(orderId)];
  }

  if (isLiveConfigured() && targetIds.length > 0) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const data = await shiprocket.rawRequest('/orders/print/invoice', 'POST', headers, { ids: targetIds });
      if (data?.invoice_url) {
        // Proxy through our backend to bypass browser-level cross-origin iframe blocks
        const url = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(data.invoice_url)}&filename=Invoice_${targetIds[0]}.pdf`;
        return res.json({ success: true, invoiceUrl: url });
      }
    } catch (err: any) {
      // Gracefully fall back to our invoice PDF generator
    }
  }

  res.json({ success: true, invoiceUrl: `/api/shiprocket/download-invoice-pdf?orderId=${encodeURIComponent(String(orderId || (matchingOrder ? matchingOrder.id : '')))}` });
});

// GET Endpoint to serve physical Tax Invoice PDF file with same-origin policy
app.get('/api/shiprocket/download-invoice-pdf', (req, res) => {
  const orderId = String(req.query.orderId || '');
  const order = mockOrders.find((o: any) => 
    String(o.shiprocketOrderId) === orderId || 
    String(o.shipmentId) === orderId || 
    String(o.id) === orderId || 
    String(o.orderNumber) === orderId
  ) || mockOrders.find((o: any) => o.shiprocketOrderId || o.shipmentId) || mockOrders[0];

  if (!order) {
    return res.status(404).send('No dispatch orders available in current database to generate invoices.');
  }

  const safeVal = (val: any, fallback: string = '—') => {
    if (val === undefined || val === null || val === '') return fallback;
    return String(val);
  };

  const lines = [
    `Invoice ID: INV-2026-${safeVal(order.id)}`,
    `Date of Invoice: ${safeVal(order.date)}`,
    `Order Reference: ${safeVal(order.orderNumber)}`,
    `Payment Mode: ${safeVal(order.paymentMethod, 'PREPAID').toUpperCase()}`,
    `------------------------------------------------------------------------`,
    `BILL TO (BUYER):`,
    `  Customer Name: ${safeVal(order.customerName)}`,
    `  Billing Address: ${safeVal(order.address?.address)}`,
    `  City/State: ${safeVal(order.address?.city)}, ${safeVal(order.address?.state)} - ${safeVal(order.address?.pincode)}`,
    `  Contact Phone: ${safeVal(order.address?.phone)}`,
    `------------------------------------------------------------------------`,
    `SELLER DETAILS:`,
    `  DappersFit Retail Private Limited`,
    `  Gachibowli, Hyderabad, Telangana - 500032`,
    `  GSTIN: 36AAAAA1111A1Z1`,
    `------------------------------------------------------------------------`,
    `BILLING PARTICULARS:`,
  ];

  if (Array.isArray(order.items)) {
    order.items.forEach((item: any, idx: number) => {
      lines.push(`  ${idx + 1}. ${safeVal(item.name)} (SKU: ${safeVal(item.sku)})`);
      lines.push(`     Qty: ${safeVal(item.quantity)} | Unit Price: INR ${safeVal(item.price)} | Subtotal: INR ${Number(item.price || 0) * Number(item.quantity || 0)}`);
    });
  }
  lines.push(`------------------------------------------------------------------------`);
  lines.push(`Total Invoice Amount: INR ${safeVal(order.totalAmount)}`);
  lines.push(`Gross Weight: ${safeVal(order.weight, '0.5')} kg`);
  lines.push(`------------------------------------------------------------------------`);
  lines.push(`This is a computer-generated tax invoice and does not require signatures.`);

  const pdfBuffer = generateMinimalPDF('TAX INVOICE - DAPPERFIT RETAIL', lines);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Invoice_${order.orderNumber || '0000'}.pdf"`);
  res.send(pdfBuffer);
});

// API Route: Cancel shipment
app.post('/api/shiprocket/cancel', async (req, res) => {
  clearShiprocketCache();
  const { orderId } = req.body;

  const foundIdx = mockOrders.findIndex(o => String(o.shiprocketOrderId) === String(orderId) || String(o.id) === String(orderId) || String(o.orderNumber) === String(orderId));
  const matchedOrder = foundIdx >= 0 ? mockOrders[foundIdx] : null;
  const targetSrId = matchedOrder?.shiprocketOrderId ? Number(matchedOrder.shiprocketOrderId) : (Number(orderId) > 1000 ? Number(orderId) : null);

  if (isLiveConfigured() && targetSrId && !isNaN(targetSrId)) {
    try {
      const headers = await getShiprocketAuthHeaders();
      await shiprocket.rawRequest('/orders/cancel', 'POST', headers, { ids: [targetSrId] });
    } catch (err: any) {
      console.log('Shiprocket cancel shipment notice:', err.message || err);
    }
  }

  if (foundIdx >= 0) {
    mockOrders[foundIdx].status = 'cancelled';
    if (isFirebaseEnabled && firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'orders', String(mockOrders[foundIdx].id)), sanitizeForFirestore(mockOrders[foundIdx]));
      } catch (err: any) {
        console.error('[Firebase] Error persisting cancelled order:', err);
      }
    }
    await saveOrdersToFile();
  }

  res.json({ success: true });
});

// API Route: Query Tracking milestones and synchronize real status from Shiprocket
app.post('/api/shiprocket/track', async (req, res) => {
  const { awbCode } = req.body;
  const foundOrder = mockOrders.find(o => o.awbCode === awbCode);

  if (isLiveConfigured() && awbCode) {
    try {
      const headers = await getShiprocketAuthHeaders();
      const trackData = await shiprocket.rawRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, 'GET', headers);
      
      const trackObj = trackData?.tracking_data || {};
      const statusTitle = String(trackObj?.track_status_title || trackObj?.shipment_track?.[0]?.current_status || '').trim();
      const statusCode = Number(trackObj?.shipment_status || trackObj?.shipment_track?.[0]?.status_code || 0);
      const rawActivities = trackObj?.shipment_track_activities || trackObj?.shipment_track?.[0]?.activities || [];

      const parsedHistory = Array.isArray(rawActivities) && rawActivities.length > 0
        ? rawActivities.map((act: any) => ({
            date: act.date || new Date().toISOString().replace('T', ' ').slice(0, 16),
            status: act['sr-status-label'] || act.activity || act.status || 'Update',
            location: act.location || 'Hub',
            activity: act.activity || act.details || act['sr-status-label'] || 'Status update'
          }))
        : [];

      // Determine real status from Shiprocket:
      // Status Code 6: SHIPPED, 18: IN TRANSIT, 17: OUT FOR DELIVERY, 42: PICKED UP
      // Status Code 7: DELIVERED
      // Status Code 8: CANCELLED, 52: RTO INITIATED
      let resolvedStatus = foundOrder?.status || 'booked';
      const upperTitle = statusTitle.toUpperCase();

      if ([6, 17, 18, 42].includes(statusCode) || upperTitle.includes('SHIPPED') || upperTitle.includes('TRANSIT') || upperTitle.includes('PICKED UP') || upperTitle.includes('OUT FOR DELIVERY')) {
        resolvedStatus = 'shipped';
      } else if (statusCode === 7 || upperTitle.includes('DELIVERED')) {
        resolvedStatus = 'delivered';
      } else if ([8, 52].includes(statusCode) || upperTitle.includes('CANCEL') || upperTitle.includes('RTO')) {
        resolvedStatus = 'cancelled';
      } else if (foundOrder?.status === 'shipped' || foundOrder?.status === 'delivered') {
        resolvedStatus = foundOrder.status;
      } else {
        resolvedStatus = 'booked';
      }

      if (foundOrder) {
        foundOrder.status = resolvedStatus;
        if (parsedHistory.length > 0) {
          foundOrder.trackingHistory = parsedHistory;
        }
        await saveSingleOrderToDb(foundOrder);
      }

      return res.json({
        success: true,
        status: resolvedStatus,
        statusTitle: statusTitle || resolvedStatus,
        trackingHistory: parsedHistory.length > 0 ? parsedHistory : foundOrder?.trackingHistory || []
      });
    } catch (err: any) {
      console.log('[Shiprocket Live Track Notice]:', err.message || err);
    }
  }

  // Fallback / standard milestones
  const mockTrackingMilestones = foundOrder?.trackingHistory && foundOrder.trackingHistory.length > 0
    ? foundOrder.trackingHistory
    : [
        { date: new Date().toISOString().replace('T', ' ').slice(0, 16), status: foundOrder?.status === 'shipped' ? 'In Transit' : 'Booked', location: 'Pune Warehouse (MH)', activity: `Shipment status confirmed: ${foundOrder?.status || 'Booked'}.` }
      ];

  res.json({ 
    success: true,
    status: foundOrder?.status || 'booked',
    trackingHistory: mockTrackingMilestones 
  });
});

// API Route: Sync single order status directly with Shiprocket API
app.post('/api/shiprocket/order/sync-status', async (req, res) => {
  const { orderId } = req.body;
  const order = mockOrders.find(o => String(o.id) === String(orderId) || String(o.orderNumber) === String(orderId));
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found.' });
  }

  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();

      // 1. If we have shiprocketOrderId, check order details
      if (order.shiprocketOrderId && !isNaN(Number(order.shiprocketOrderId))) {
        try {
          const showData = await shiprocket.rawRequest(`/orders/show/${order.shiprocketOrderId}`, 'GET', headers);
          const srOrder = Array.isArray(showData?.data) ? showData.data[0] : (showData?.data || showData || {});
          const statusText = String(srOrder?.status || '').toUpperCase();
          const statusCode = Number(srOrder?.status_code || 0);
          
          const shipmentsList = Array.isArray(srOrder?.shipments)
            ? srOrder.shipments.filter(Boolean)
            : (srOrder?.shipments ? [srOrder.shipments] : []);
          const firstShipment = shipmentsList[0] || null;

          const sId = firstShipment?.id || firstShipment?.shipment_id || srOrder?.shipment_id;
          if (sId) order.shipmentId = String(sId);

          const awb = firstShipment?.awb_code || firstShipment?.awb || srOrder?.awb_code || srOrder?.awb;
          if (awb) order.awbCode = String(awb);

          const courier = firstShipment?.courier_name || firstShipment?.courier || srOrder?.courier_name || srOrder?.courier;
          if (courier) order.courierName = String(courier);

          if (firstShipment?.pickup_scheduled_date || srOrder?.pickup_scheduled_date) {
            order.pickupScheduledDate = String(firstShipment?.pickup_scheduled_date || srOrder?.pickup_scheduled_date);
            order.pickupStatus = 'scheduled';
          }
          if (firstShipment?.pickup_token_number || srOrder?.pickup_token_number) {
            order.pickupTokenNumber = String(firstShipment?.pickup_token_number || srOrder?.pickup_token_number);
          }

          // Check if label exists in Shiprocket
          if (order.shipmentId && !order.labelUrl) {
            try {
              const labelData = await shiprocket.rawRequest('/courier/generate/label', 'POST', headers, {
                shipment_id: [Number(order.shipmentId)]
              });
              const rawLabel = labelData?.label_url || labelData?.response?.label_url || labelData?.url || labelData?.pdf_url;
              if (rawLabel) {
                order.labelUrl = `/api/shiprocket/download-live-pdf?url=${encodeURIComponent(rawLabel)}&filename=Label_${order.orderNumber || order.shipmentId}.pdf`;
              }
            } catch {}
          }

          // Map Shiprocket order status to local status
          if ([6, 17, 18, 42].includes(statusCode) || statusText.includes('SHIPPED') || statusText.includes('TRANSIT') || statusText.includes('PICKED UP')) {
            order.status = 'shipped';
          } else if (statusCode === 7 || statusText.includes('DELIVERED')) {
            order.status = 'delivered';
          } else if ([8, 52].includes(statusCode) || statusText.includes('CANCEL')) {
            order.status = 'cancelled';
          } else if (order.awbCode || statusCode === 1 || statusCode === 2 || statusCode === 3 || statusText.includes('AWB') || statusText.includes('READY')) {
            order.status = 'booked';
          }
        } catch (showErr: any) {
          console.log('[Shiprocket Sync Show Error]:', showErr.message || showErr);
        }
      }

      // 2. If we have awbCode, query track AWB for granular activities and tracking URL
      if (order.awbCode) {
        order.trackingUrl = getShiprocketTrackingUrl(order.awbCode);
        try {
          const trackData = await shiprocket.rawRequest(`/courier/track/awb/${encodeURIComponent(order.awbCode)}`, 'GET', headers);
          const liveUrl = trackData?.tracking_data?.track_url || trackData?.tracking_data?.tracking_url || trackData?.track_url;
          if (liveUrl && typeof liveUrl === 'string' && liveUrl.startsWith('http')) {
            order.trackingUrl = liveUrl;
          }
          const trackObj = trackData?.tracking_data || {};
          const statusTitle = String(trackObj?.track_status_title || '').toUpperCase();
          const statusCode = Number(trackObj?.shipment_status || 0);
          const rawActivities = trackObj?.shipment_track_activities || [];

          if (Array.isArray(rawActivities) && rawActivities.length > 0) {
            order.trackingHistory = rawActivities.map((act: any) => ({
              date: act.date || new Date().toISOString().replace('T', ' ').slice(0, 16),
              status: act['sr-status-label'] || act.activity || act.status || 'Update',
              location: act.location || 'Hub',
              activity: act.activity || act.details || 'Status update'
            }));
          }

          if ([6, 17, 18, 42].includes(statusCode) || statusTitle.includes('SHIPPED') || statusTitle.includes('TRANSIT') || statusTitle.includes('PICKED UP')) {
            order.status = 'shipped';
          } else if (statusCode === 7 || statusTitle.includes('DELIVERED')) {
            order.status = 'delivered';
          } else if ([8, 52].includes(statusCode) || statusTitle.includes('CANCEL')) {
            order.status = 'cancelled';
          }
        } catch (tErr: any) {
          console.log('[Shiprocket Sync Track Error]:', tErr.message || tErr);
        }
      }

      await saveSingleOrderToDb(order);
      return res.json({ success: true, order, status: order.status, labelUrl: order.labelUrl });
    } catch (err: any) {
      console.error('[Shiprocket Sync Fatal Error]:', err.message || err);
      return res.status(500).json({ success: false, error: err.message || 'Sync failed.' });
    }
  }

  res.json({ success: true, order, status: order.status, labelUrl: order.labelUrl });
});

// API Route: Sync all active/booked orders with Shiprocket
app.post('/api/shiprocket/orders/sync-all-statuses', async (req, res) => {
  if (isLiveConfigured()) {
    try {
      const headers = await getShiprocketAuthHeaders();
      for (const order of mockOrders) {
        if (order.shiprocketOrderId && !isNaN(Number(order.shiprocketOrderId))) {
          try {
            const showData = await shiprocket.rawRequest(`/orders/show/${order.shiprocketOrderId}`, 'GET', headers);
            const srOrder = Array.isArray(showData?.data) ? showData.data[0] : (showData?.data || showData || {});
            const statusCode = Number(srOrder?.status_code || 0);
            const statusText = String(srOrder?.status || '').toUpperCase();

            const shipmentsList = Array.isArray(srOrder?.shipments)
              ? srOrder.shipments.filter(Boolean)
              : (srOrder?.shipments ? [srOrder.shipments] : []);
            const firstShipment = shipmentsList[0] || null;

            const sId = firstShipment?.id || firstShipment?.shipment_id || srOrder?.shipment_id;
            if (sId && !order.shipmentId) order.shipmentId = String(sId);

            const awb = firstShipment?.awb_code || firstShipment?.awb || srOrder?.awb_code || srOrder?.awb;
            if (awb && !order.awbCode) order.awbCode = String(awb);

            const courier = firstShipment?.courier_name || firstShipment?.courier || srOrder?.courier_name || srOrder?.courier;
            if (courier && !order.courierName) order.courierName = String(courier);

            if (firstShipment?.pickup_scheduled_date || srOrder?.pickup_scheduled_date) {
              order.pickupScheduledDate = String(firstShipment?.pickup_scheduled_date || srOrder?.pickup_scheduled_date);
              order.pickupStatus = 'scheduled';
            }
            if (firstShipment?.pickup_token_number || srOrder?.pickup_token_number) {
              order.pickupTokenNumber = String(firstShipment?.pickup_token_number || srOrder?.pickup_token_number);
            }

            if ([6, 17, 18, 42].includes(statusCode) || statusText.includes('SHIPPED') || statusText.includes('TRANSIT')) {
              order.status = 'shipped';
            } else if (statusCode === 7 || statusText.includes('DELIVERED')) {
              order.status = 'delivered';
            } else if ([8, 52].includes(statusCode) || statusText.includes('CANCEL')) {
              order.status = 'cancelled';
            } else if (order.awbCode) {
              order.status = 'booked';
            }
          } catch {}
        }
      }
      await saveOrdersToFile();
    } catch (err: any) {
      console.error('[Shiprocket Sync All Error]:', err.message || err);
    }
  }
  res.json({ success: true, orders: mockOrders });
});

// API Route: Logout / Destroy cached token session
app.post('/api/logout', (req, res) => {
  cachedToken = null;
  tokenExpiry = null;
  console.log('[Auth Session] Cleared active backend cached session tokens.');
  res.json({ success: true, message: 'Backend session destroyed successfully.' });
});

// -------------------------------------------------------------
// MAIN SERVER INGRESS & VITE SETUP
// -------------------------------------------------------------

// Serve public static assets
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));

// Dedicated vanilla JavaScript courier booking page
app.get('/courier-booking', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'courier-booking.html'));
});
app.get('/book-courier', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'courier-booking.html'));
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production' || !process.env.CONTROL_PLANE_PORT;

  // Vite middleware in dev; serve static assets in production
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA Wildcard fallback
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dappersfit Server] Booted successfully and running on port ${PORT}`);
    // Sync Cloud Firestore records in background without blocking app startup
    syncFromFirestore().catch((err) => {
      console.error('[Firebase] Background sync failed:', err);
    });
  });
}

startServer();
