"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { Copy, Check, X } from "lucide-react";
import { auth } from "@/lib/firebase";
import { useDisplayName, ensureUserProfile, setDisplayName } from "@/lib/users";
import { useEncryption } from "@/lib/use-encryption";
import { getUnlocked } from "@/lib/key-store";
import { MeProfileCard } from "@/components/MeProfileCard";
import { MeSettingsSection, MeSettingsRow } from "@/components/MeSettingsSection";
import { ThemeToggle } from "@/lib/theme";

// ---------- Recovery phrase modal ----------------------------------------

function RecoveryPhraseModal({
  phrase,
  onClose,
}: {
  phrase: string;
  onClose: () => void;
}) {
  const words = phrase.split(" ");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 bg-bg/90 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-bg-2 border border-line rounded-card p-6 space-y-5 animate-fade-up">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold tracking-tight text-fg">
              Recovery phrase
            </h2>
            <p className="text-xs text-fg-dim mt-1 leading-snug">
              12 words. Required to unlock on a fresh device. Keep it offline —
              never screenshot, never email.
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-fg-fade hover:text-fg transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 num">
          {words.map((w, i) => (
            <div
              key={i}
              className="border border-line rounded-md px-2 py-1.5 text-sm bg-bg"
            >
              <span className="text-fg-fade text-xs mr-1">{i + 1}.</span>
              {w}
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={handleCopy}
            className="btn-ghost flex items-center gap-2 text-xs"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" /> Copy phrase
              </>
            )}
          </button>
          <button onClick={onClose} className="btn-primary text-xs ml-auto">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Edit profile modal -------------------------------------------

function EditProfileModal({
  uid,
  currentName,
  onClose,
  onSaved,
}: {
  uid: string;
  currentName: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("saving");
    setError("");
    try {
      await setDisplayName(uid, name);
      setStatus("saved");
      onSaved(name.trim());
      setTimeout(() => onClose(), 800);
    } catch (err: unknown) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-bg/90 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-bg-2 border border-line rounded-card p-6 space-y-4 animate-fade-up">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-tight text-fg">
            Edit profile
          </h2>
          <button
            onClick={onClose}
            className="text-fg-fade hover:text-fg transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="label block mb-1.5">Display name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="How friends see you"
              className="field"
              maxLength={32}
              required
              autoFocus
            />
            <p className="text-xs text-fg-fade mt-1.5">
              1–32 characters. Shown on portfolios you share.
            </p>
          </div>

          {status === "error" && error && (
            <div className="border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
              {error}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={status === "saving"}
              className="btn-primary disabled:opacity-50"
            >
              {status === "saving"
                ? "Saving…"
                : status === "saved"
                  ? "Saved"
                  : "Save"}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- Delete account confirm modal ----------------------------------

function DeleteAccountModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-bg/90 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-bg-2 border border-line rounded-card p-6 space-y-4 animate-fade-up">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-tight text-neg">
            Delete account
          </h2>
          <button
            onClick={onClose}
            className="text-fg-fade hover:text-fg transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-fg-dim leading-snug">
          Account deletion removes all your encrypted data and revokes access
          for anyone you&apos;ve shared with. This cannot be undone.
        </p>
        <p className="text-xs text-fg-fade">
          To delete your account, please contact support or remove your data
          manually from each portfolio, then sign out.
        </p>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="btn-primary ml-auto">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Page ----------------------------------------------------------

export default function MePage() {
  const router = useRouter();
  const encryption = useEncryption();
  const [user, setUser] = useState<User | null>(null);

  // Modal visibility
  const [showPhrase, setShowPhrase] = useState(false);
  const [phraseText, setPhraseText] = useState<string | null>(null);
  const [phraseError, setPhraseError] = useState("");
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);

  // UID copy state
  const [uidCopied, setUidCopied] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.push("/login");
        return;
      }
      setUser(u);
      try {
        await ensureUserProfile(u);
      } catch {}
    });
  }, [router]);

  const displayName =
    useDisplayName(user?.uid ?? "") || user?.displayName || "Me";

  // Derive the recovery phrase from the in-memory master secret.
  const handleViewPhrase = async () => {
    if (!user) return;
    setPhraseError("");
    const unlocked = getUnlocked(user.uid);
    if (!unlocked) {
      setPhraseError(
        "Encryption is not unlocked. Refresh the page and try again.",
      );
      return;
    }
    try {
      const { seedToPhrase } = await import("@/lib/recovery-phrase");
      const phrase = await seedToPhrase(unlocked.masterSecret);
      setPhraseText(phrase);
      setShowPhrase(true);
    } catch (err) {
      setPhraseError(
        err instanceof Error ? err.message : "Failed to derive phrase",
      );
    }
  };

  const handleCopyUid = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setUidCopied(true);
      setTimeout(() => setUidCopied(false), 1500);
    } catch {}
  };

  const handleSignOut = async () => {
    await signOut(auth);
    router.push("/login");
  };

  if (!user) return null;

  const isUnlocked = encryption.state.kind === "unlocked";

  return (
    <>
      <div className="px-6 md:px-8 py-7 max-w-3xl">
        <header className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">
            Me
          </h1>
          <p className="mt-1 text-xs text-fg-mid">
            Profile, security, and how the app behaves
          </p>
        </header>

        <MeProfileCard
          uid={user.uid}
          displayName={displayName}
          email={user.email ?? ""}
          onEdit={() => setShowEditProfile(true)}
        />

        <MeSettingsSection title="Security">
          {phraseError && (
            <div className="px-[22px] py-3 text-xs text-neg border-b border-line">
              {phraseError}
            </div>
          )}
          <MeSettingsRow
            name="Recovery phrase"
            description="12 words. Required to unlock from a fresh device. Keep it offline."
            right={
              <span className="text-xs text-fg-mid">
                {isUnlocked ? "View" : "Locked"}
              </span>
            }
            onClick={isUnlocked ? handleViewPhrase : undefined}
          />
          <div className="px-[22px] py-3.5 border-b border-line last:border-b-0">
            <div className="flex flex-col gap-1 mb-2">
              <div className="text-[13.5px] font-medium text-fg">Your UID</div>
              <div className="text-xs text-fg-fade leading-snug">
                Share this so friends can add you to their portfolios.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="num text-xs text-fg-dim bg-bg border border-line rounded-md px-2.5 py-1.5 break-all flex-1 min-w-0">
                {user.uid}
              </code>
              <button
                type="button"
                onClick={handleCopyUid}
                className="btn-ghost flex items-center gap-1.5 shrink-0 text-xs"
              >
                {uidCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </>
                )}
              </button>
            </div>
          </div>
        </MeSettingsSection>

        <MeSettingsSection title="Connections">
          <MeSettingsRow
            name="Brokers"
            description="Manage broker connections inside each portfolio. API keys are encrypted in your browser."
            right={
              <span className="text-xs text-fg-mid">Manage in Mine</span>
            }
            onClick={() => router.push("/mine")}
          />
        </MeSettingsSection>

        <MeSettingsSection title="Appearance">
          <div className="flex items-center justify-between px-[22px] py-3.5">
            <div className="flex flex-col gap-0.5">
              <div className="text-[13.5px] font-medium text-fg">Theme</div>
              <div className="text-xs text-fg-fade leading-snug">
                Dark by default. Light flips colors but keeps the same density.
              </div>
            </div>
            <ThemeToggle />
          </div>
        </MeSettingsSection>

        <MeSettingsSection title="Account">
          <MeSettingsRow
            name="Sign out"
            description="Clears the cached encryption key on this device. You'll re-unlock on next sign-in."
            onClick={handleSignOut}
          />
          <MeSettingsRow
            name="Delete account"
            description="Erases all your encrypted data and revokes shares. Cannot be undone."
            danger
            onClick={() => setShowDeleteAccount(true)}
          />
        </MeSettingsSection>
      </div>

      {showPhrase && phraseText && (
        <RecoveryPhraseModal
          phrase={phraseText}
          onClose={() => {
            setShowPhrase(false);
            setPhraseText(null);
          }}
        />
      )}

      {showEditProfile && (
        <EditProfileModal
          uid={user.uid}
          currentName={displayName}
          onClose={() => setShowEditProfile(false)}
          onSaved={() => setShowEditProfile(false)}
        />
      )}

      {showDeleteAccount && (
        <DeleteAccountModal onClose={() => setShowDeleteAccount(false)} />
      )}
    </>
  );
}
