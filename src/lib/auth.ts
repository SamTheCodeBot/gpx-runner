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

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  // IMPORTANT: Start as true to prevent flash of login form while Firebase initializes
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If no auth object (SSR or not initialized), skip auth
    if (!auth) {
      setLoading(false);
      return;
    }

    // Set up auth state listener
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    }, (error) => {
      console.error("Auth error:", error);
      setError(error.message);
      setLoading(false);
    });

    // Cleanup on unmount
    return unsubscribe;
  }, []);

  return { user, loading, error };
};

export const login = async (email: string, password: string) => {
  if (!auth) throw new Error("Auth not initialized");
  return signInWithEmailAndPassword(auth, email, password);
};

export const register = async (email: string, password: string) => {
  if (!auth) throw new Error("Auth not initialized");
  return createUserWithEmailAndPassword(auth, email, password);
};

export const logout = async () => {
  if (!auth) throw new Error("Auth not initialized");
  return signOut(auth);
};

export const resetPassword = async (email: string) => {
  if (!auth) throw new Error("Auth not initialized");
  return sendPasswordResetEmail(auth, email);
};