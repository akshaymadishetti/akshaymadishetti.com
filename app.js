const contactForm = document.querySelector("#contact-form");
const formStatus = document.querySelector("#form-status");
const apiStatus = document.querySelector("#api-status");

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("on");
      }
    });
  },
  { threshold: 0.12 }
);

document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

function setFormStatus(message, type = "") {
  if (!formStatus) {
    return;
  }

  formStatus.textContent = message;
  formStatus.className = `form-status ${type}`.trim();
}

function setApiStatus(message, type = "") {
  if (!apiStatus) {
    return;
  }

  apiStatus.textContent = message;
  apiStatus.className = `backend-status ${type}`.trim();
}

async function checkBackend() {
  try {
    const response = await fetch("/api/health");
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error("Backend health check failed.");
    }

    setApiStatus("Backend online - messages save to server", "online");
  } catch (error) {
    setApiStatus("Backend unavailable - start the Node server", "offline");
  }
}

function getFormPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function sendContactMessage(event) {
  event.preventDefault();

  const button = contactForm.querySelector("button[type='submit']");
  button.disabled = true;
  setFormStatus("Sending...");

  try {
    const response = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getFormPayload(contactForm))
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Unable to send message.");
    }

    contactForm.reset();
    setFormStatus("Thanks. Your message was saved successfully.", "success");
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

if (contactForm) {
  contactForm.addEventListener("submit", sendContactMessage);
}

checkBackend();
