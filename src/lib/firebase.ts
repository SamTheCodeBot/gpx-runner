import { initializeApp, FirebaseApp } from 'firebase/app';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { getAuth, Auth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyAXfw2fx-P6DrB0yKZuQ6pBjfXrHYZRCRw",
  authDomain: "gps-runner-d2b79.firebaseapp.com",
  projectId: "gps-runner-d2b79",
  storageBucket: "gps-runner-d2b79.firebasestorage.app",
  messagingSenderId: "597838972889",
  appId: "1:597838972889:web:99ddd1442278f939f0fbc8",
  measurementId: "G-TY9Z9WB4ZW"
};

// Initialize Firebase - only on client side
let app: FirebaseApp | undefined;
let storage: FirebaseStorage | undefined;
let auth: Auth | undefined;

if (typeof window !== 'undefined') {
  try {
    app = initializeApp(firebaseConfig);
    storage = getStorage(app);
    auth = getAuth(app);
  } catch (e) {
    console.error("Firebase init error:", e);
  }
}

export { storage, auth };
export default app;