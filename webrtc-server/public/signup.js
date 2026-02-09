const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;

const signupFormEl = document.getElementById("signupForm");
const signupUsernameEl = document.getElementById("signupUsername");
const signupPasswordEl = document.getElementById("signupPassword");
const signupPasswordConfirmEl = document.getElementById("signupPasswordConfirm");
const signupReasonEl = document.getElementById("signupReason");
const togglePasswordEl = document.getElementById("toggleSignupPassword");
const signupErrorEl = document.getElementById("signupError");
const signupSuccessEl = document.getElementById("signupSuccess");

const setError = (text) => {
  if (signupErrorEl) {
    signupErrorEl.textContent = text || "";
  }
};

const setSuccess = (text) => {
  if (signupSuccessEl) {
    signupSuccessEl.textContent = text || "";
  }
};

const meetsPasswordPolicy = (password) => {
  if (typeof password !== "string") {
    return false;
  }
  if (password.length < 8) {
    return false;
  }
  if (!/[0-9]/.test(password)) {
    return false;
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return false;
  }
  return true;
};

if (togglePasswordEl && signupPasswordEl) {
  togglePasswordEl.addEventListener("click", () => {
    const isPassword = signupPasswordEl.type === "password";
    signupPasswordEl.type = isPassword ? "text" : "password";
    togglePasswordEl.textContent = isPassword ? "Hide" : "Show";
  });
}

if (signupFormEl) {
  signupFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    const username = signupUsernameEl ? signupUsernameEl.value.trim() : "";
    const password = signupPasswordEl ? signupPasswordEl.value : "";
    const passwordConfirm = signupPasswordConfirmEl ? signupPasswordConfirmEl.value : "";
    const reason = signupReasonEl ? signupReasonEl.value.trim() : "";

    if (!username || !password || !passwordConfirm || !reason) {
      setError("Fill all fields");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Passwords do not match");
      return;
    }
    if (!meetsPasswordPolicy(password)) {
      setError("Password must be 8+ chars incl number and special");
      return;
    }

    try {
      const response = await fetch(`${apiBase}/api/signup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, passwordConfirm, reason })
      });

      if (!response.ok) {
        let errorPayload = null;
        try {
          errorPayload = await response.json();
        } catch (parseError) {
          errorPayload = null;
        }
        const code = errorPayload && errorPayload.error ? errorPayload.error : "failed";
        if (code === "username-taken") {
          setError("Username already exists");
        } else if (code === "username-pending") {
          setError("Signup request already pending");
        } else if (code === "weak-password") {
          setError("Password must be 8+ chars incl number and special");
        } else if (code === "password-mismatch") {
          setError("Passwords do not match");
        } else {
          setError("Signup failed");
        }
        return;
      }

      setSuccess("Request submitted. Wait for admin approval before login.");
      if (signupPasswordEl) {
        signupPasswordEl.value = "";
      }
      if (signupPasswordConfirmEl) {
        signupPasswordConfirmEl.value = "";
      }
    } catch (error) {
      setError("Signup failed");
    }
  });
}

if (signupUsernameEl) {
  signupUsernameEl.focus();
}
