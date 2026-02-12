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
const toggleConfirmPasswordEl = document.getElementById("toggleSignupPasswordConfirm");
const signupErrorEl = document.getElementById("signupError");
const signupSuccessEl = document.getElementById("signupSuccess");
const policyLengthEl = document.getElementById("policyLength");
const policyNumberEl = document.getElementById("policyNumber");
const policySpecialEl = document.getElementById("policySpecial");
const policyMatchEl = document.getElementById("policyMatch");

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

const hasMinPasswordLength = (password) => typeof password === "string" && password.length >= 8;
const hasPasswordNumber = (password) => typeof password === "string" && /[0-9]/.test(password);
const hasPasswordSpecial = (password) => typeof password === "string" && /[^A-Za-z0-9\s]/.test(password);
const passwordMatchesConfirm = (password, confirm) => (
  typeof password === "string"
  && typeof confirm === "string"
  && confirm.length > 0
  && password === confirm
);

const meetsPasswordPolicy = (password) => (
  hasMinPasswordLength(password)
  && hasPasswordNumber(password)
  && hasPasswordSpecial(password)
);

const updatePasswordPolicyUi = () => {
  const password = signupPasswordEl ? signupPasswordEl.value : "";
  const confirm = signupPasswordConfirmEl ? signupPasswordConfirmEl.value : "";
  const items = [
    { el: policyLengthEl, ok: hasMinPasswordLength(password), label: "8+ characters" },
    { el: policyNumberEl, ok: hasPasswordNumber(password), label: "Includes a number" },
    { el: policySpecialEl, ok: hasPasswordSpecial(password), label: "Includes a special character" },
    { el: policyMatchEl, ok: passwordMatchesConfirm(password, confirm), label: "Confirm matches" }
  ];
  for (const item of items) {
    if (!item.el) {
      continue;
    }
    item.el.textContent = `${item.ok ? "[OK]" : "[ ]"} ${item.label}`;
    item.el.classList.toggle("met", item.ok);
    item.el.classList.toggle("unmet", !item.ok);
  }
};

if (togglePasswordEl && signupPasswordEl) {
  togglePasswordEl.addEventListener("click", () => {
    const isPassword = signupPasswordEl.type === "password";
    signupPasswordEl.type = isPassword ? "text" : "password";
    togglePasswordEl.textContent = isPassword ? "Hide" : "Show";
  });
}

if (toggleConfirmPasswordEl && signupPasswordConfirmEl) {
  toggleConfirmPasswordEl.addEventListener("click", () => {
    const isPassword = signupPasswordConfirmEl.type === "password";
    signupPasswordConfirmEl.type = isPassword ? "text" : "password";
    toggleConfirmPasswordEl.textContent = isPassword ? "Hide" : "Show";
  });
}

if (signupPasswordEl) {
  signupPasswordEl.addEventListener("input", updatePasswordPolicyUi);
}

if (signupPasswordConfirmEl) {
  signupPasswordConfirmEl.addEventListener("input", updatePasswordPolicyUi);
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
      updatePasswordPolicyUi();
    } catch (error) {
      setError("Signup failed");
    }
  });
}

if (signupUsernameEl) {
  signupUsernameEl.focus();
}

updatePasswordPolicyUi();
