"use client";

export interface BrowserPasskeyChallenge {
  challengeId: string;
  challenge: string;
  rpId: string;
  allowCredentialIds: readonly string[];
  userVerification: "required";
}

function decodeBase64Url(value: string) {
  const bytes = Uint8Array.from(atob(
    value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "="
    )
  ), (char) => char.charCodeAt(0));
  return bytes.buffer;
}

function encodeBase64Url(value: ArrayBuffer | null) {
  if (!value) return null;
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/+/g, "-").replace(///g, "_").replace(/=+$/g, "");
}

export async function getPasskeyAssertion(challenge: BrowserPasskeyChallenge) {
  if (!("credentials" in navigator) || !window.PublicKeyCredential) {
    throw new Error("This browser does not support passkeys.");
  }

  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: decodeBase64Url(challenge.challenge),
      rpId: challenge.rpId,
      allowCredentials: challenge.allowCredentialIds.map((id) => ({
        id: decodeBase64Url(id),
        type: "public-key" as const
      })),
      userVerification: challenge.userVerification,
      timeout: 120_000
    }
  });

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey authentication was cancelled or unavailable.");
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Passkey returned an unexpected credential response.");
  }

  return {
    id: credential.id,
    type: "public-key" as const,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON)!,
      authenticatorData: encodeBase64Url(response.authenticatorData)!,
      signature: encodeBase64Url(response.signature)!,
      userHandle: encodeBase64Url(response.userHandle)
    }
  };
}
