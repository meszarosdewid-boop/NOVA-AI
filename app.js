
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const messages = document.getElementById("messages");
const history = [];

document.getElementById("year").textContent = new Date().getFullYear();

function addMessage(text, role) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = input.value.trim();
  if (!message) return;

  addMessage(message, "user");

  // Aktuálnu správu uložíme do histórie iba raz.
  history.push({ role: "user", content: message });

  input.value = "";

  const pending = addMessage("Pripravujem odpoveď...", "assistant");
  const button = form.querySelector("button");
  button.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-ID": "demo"
      },
      body: JSON.stringify({
        message,
        history: history.slice(0, -1).slice(-50)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Požiadavku sa nepodarilo spracovať."
      );
    }

    pending.textContent = data.reply;

    history.push({
      role: "assistant",
      content: data.reply
    });

  } catch (error) {
    pending.classList.add("error");
    pending.textContent = error.message || "Nastala chyba.";
  } finally {
    button.disabled = false;
    input.focus();
  }
});
