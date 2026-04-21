import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAQgpOsdm8XjVeWYvahfhH7OdSeRptci7o",
  authDomain: "shared-portfolio-manager.firebaseapp.com",
  projectId: "shared-portfolio-manager",
  storageBucket: "shared-portfolio-manager.firebasestorage.app",
  messagingSenderId: "61362598574",
  appId: "1:61362598574:web:0eed28a14c99f42bde733f",
  measurementId: "G-QNXGSZMZD9"
};

// Initialize Firebase securely to avoid re-initialization
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = getFirestore(app);
