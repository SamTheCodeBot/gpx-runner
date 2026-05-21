import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebaseAdmin";

const ALLOWED_ADMIN_EMAIL = "mago@osterhult.com";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    // Only allow the specific admin email
    if (email.toLowerCase() !== ALLOWED_ADMIN_EMAIL.toLowerCase()) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Verify user exists in Firebase Auth
    let uid: string;
    try {
      const userRecord = await adminAuth().getUserByEmail(email);
      uid = userRecord.uid;
    } catch {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Create a custom token for session management
    // In production you'd use a proper session cookie approach
    const customToken = await adminAuth().createCustomToken(uid, {
      adminEmail: email,
      role: "crewcaptain",
    });

    return NextResponse.json({ token: customToken, email, uid });
  } catch (err) {
    console.error("[crewcaptain/login]", err);
    return NextResponse.json({ error: "Authentication failed" }, { status: 500 });
  }
}