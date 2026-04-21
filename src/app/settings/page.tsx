"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { ArrowLeft, Copy, Check } from "lucide-react";
import { auth, db } from "@/lib/firebase";
import { ThemeToggle } from "@/lib/theme";
import { ensureUserProfile, setDisplayName } from "@/lib/users";

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.push("/login");
        return;
      }
      setUser(u);
      try {
        await ensureUserProfile(u);
        const snap = await getDoc(doc(db, "users", u.uid));
        const current = snap.exists()
          ? ((snap.data().displayName as string) ?? "")
          : "";
        setName(current);
      } catch {
        // ignore — user can still type a name
      }
      setLoading(false);
    });
    return () => unsub();
  }, [router]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setStatus("saving");
    setError("");
    try {
      await setDisplayName(user.uid, name);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err: unknown) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleCopy = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-sm text-fg-dim">Loading…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="px-6 lg:px-10 pt-6 pb-4 border-b border-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <Link
            href="/"
            className="text-sm text-fg-dim hover:text-accent transition flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 lg:px-10 py-10 space-y-8">
        <div className="animate-fade-up">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-fg-dim mt-1">
            Control how others see you.
          </p>
        </div>

        <section className="card p-6 animate-fade-up">
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="label block mb-1.5">Display name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="How friends see you"
                className="field"
                maxLength={32}
                required
              />
              <p className="text-xs text-fg-fade mt-2">
                1-32 characters. Shown on portfolios you share.
              </p>
            </div>
            {status === "error" && error && (
              <div className="border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
                {error}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={status === "saving"}
                className="btn-primary disabled:opacity-50"
              >
                {status === "saving" ? "Saving…" : "Save"}
              </button>
              {status === "saved" && (
                <span className="text-sm text-pos">Saved</span>
              )}
            </div>
          </form>
        </section>

        <section
          className="card p-6 animate-fade-up"
          style={{ animationDelay: "80ms" }}
        >
          <div className="label mb-2">Your UID</div>
          <p className="text-xs text-fg-dim mb-3">
            Share this so friends can add you to their portfolios.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="num text-xs text-fg-dim bg-bg-2 border border-line rounded-md px-2.5 py-1.5 break-all flex-1 min-w-0">
              {user?.uid}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="btn-ghost flex items-center gap-2 shrink-0"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4" /> Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" /> Copy
                </>
              )}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
