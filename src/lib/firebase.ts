import { initializeApp } from 'firebase/app';
import { getStorage } from 'firebase/storage';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyAXfw2fx-P6DrB0yKZuQ6pBjfXrHYZRCRw",
  authDomain: "gps-runner-d2b79.firebaseapp.com",
  projectId: "gps-runner-d2b79",
  storageBucket: "gps-runner-d2b79.firebasestorage.app",
  messagingSenderId: "597838972889",
  appId: "1:597838972889:web:99ddd1442278f939f0fbc8",
  measurementId: "G-TY9Z9WB4ZW"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const storage = getStorage(app);
export const auth = getAuth(app);

export default app;