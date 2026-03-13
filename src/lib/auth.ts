import { useState, useEffect } from 'react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  User
} from 'firebase/auth';
import { auth } from './firebase';

// Dummy auth that doesn't use Firebase - for use on static hosting
// Set to false and add proper Firebase config when deploying to Vercel
const USE_DUMMY_AUTH = true;

export const useAuth = () => {
  // Always return "logged out" state for static deployment
  // This bypasses Firebase initialization issues
  return { 
    user: null, 
    loading: false, 
    error: null 
  };
};

export const login = async (email: string, password: string) => {
  if (USE_DUMMY_AUTH) {
    // For testing - just accept any login
    console.log("Dummy login:", email);
    return { user: { email } };
  }
  if (!auth) throw new Error("Auth not initialized");
  return signInWithEmailAndPassword(auth, email, password);
};

export const register = async (email: string, password: string) => {
  if (USE_DUMMY_AUTH) {
    console.log("Dummy register:", email);
    return { user: { email } };
  }
  if (!auth) throw new Error("Auth not initialized");
  return createUserWithEmailAndPassword(auth, email, password);
};

export const logout = async () => {
  if (USE_DUMMY_AUTH) {
    console.log("Dummy logout");
    return;
  }
  if (!auth) throw new Error("Auth not initialized");
  return signOut(auth);
};

export const resetPassword = async (email: string) => {
  if (USE_DUMMY_AUTH) {
    console.log("Dummy reset password:", email);
    return;
  }
  if (!auth) throw new Error("Auth not initialized");
  return sendPasswordResetEmail(auth, email);
};