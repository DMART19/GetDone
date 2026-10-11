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
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

export async function createOwnerPasskey(token: string): Promise<{ userId: string }> {
  async function post(path: string, body: unknown) {
    const response = await fetch(`/api/control/auth/enrollment/${path}`, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error?.message || "Owner setup is unavailable");
    return result.data;
  }
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
  const options = await post("begin", { token });
  const credential = await navigator.credentials.create({ publicKey: {
    ...options, challenge: decodeBase64Url(options.challenge),
    user: { ...options.user, id: decodeBase64Url(options.user.id) },
    excludeCredentials: []
  }});
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Passkey creation was cancelled or unavailable.");
  }
  return post("complete", { token, credential: {
    id: credential.id, rawId: encodeBase64Url(credential.rawId), type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      attestationObject: encodeBase64Url(credential.response.attestationObject),
      transports: credential.response.getTransports()
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined
  }});
}
