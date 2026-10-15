const $ = id => document.getElementById(id);

let products = [];
let currentUser = null;
let authMode = "login";
let pendingBookingId = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

function message(id, text, success = false) {
  const el = $(id);
  el.textContent = text;
  el.style.color = success ? "green" : "crimson";
}

function showAccount() {
  $("accountPanel").hidden = false;
}

function hideAccount() {
  $("accountPanel").hidden = true;
}

function renderProducts(list) {
  const grid = $("productGrid");

  if (!list.length) {
    grid.innerHTML = "<p>No products found.</p>";
    return;
  }

  grid.innerHTML = list.map(p => `
    <article class="product">
      <img
        src="${escapeHtml(p.image_url)}"
        alt="${escapeHtml(p.name)}"
        loading="lazy"
        onerror="this.style.display='none'"
      >

      <div class="product-body">
        <small>${escapeHtml(p.category)}</small>
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.description || "")}</p>

        <div class="product-bottom">
          <strong>₹${Number(p.daily_price).toLocaleString("en-IN")}/day</strong>
          <button class="primary" data-book="${p.id}">
            Book now
          </button>
        </div>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll("[data-book]").forEach(button => {
    button.addEventListener("click", () => {
      startBooking(Number(button.dataset.book));
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

async function loadCategories() {
  const data = await api("/api/categories");

  $("categorySelect").innerHTML = [
    '<option value="All">All categories</option>',
    ...(data.categories || [])
      .filter(c => c !== "All")
      .map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
  ].join("");
}

async function loadProducts() {
  try {
    const q = $("searchInput").value.trim();
    const category = $("categorySelect").value;

    const data = await api(
      `/api/products?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`
    );

    products = data.products || [];
    renderProducts(products);
  } catch (error) {
    $("productGrid").textContent = error.message;
  }
}

async function refreshUser() {
  const data = await api("/api/me");
  currentUser = data.user;

  $("accountBtn").textContent =
    currentUser ? currentUser.name : "Login / Sign up";

  $("myBookingsBtn").hidden = !currentUser;
  $("logoutBtn").hidden = !currentUser;

  $("authForm").hidden = Boolean(currentUser);
  $("signedInText").hidden = !currentUser;

  if (currentUser) {
    $("signedInText").textContent =
      `Signed in as ${currentUser.email}`;
    $("authTitle").textContent = `Welcome, ${currentUser.name}`;
  }
}

function chooseAuth(mode) {
  authMode = mode;

  $("loginTab").classList.toggle("selected", mode === "login");
  $("registerTab").classList.toggle("selected", mode === "register");

  $("nameWrap").hidden = mode !== "register";
  $("nameInput").required = mode === "register";

  $("authTitle").textContent =
    mode === "login" ? "Welcome back" : "Create account";

  $("authSubmit").textContent =
    mode === "login" ? "Login" : "Create account";

  $("passwordInput").autocomplete =
    mode === "login" ? "current-password" : "new-password";

  message("authMessage", "");
}

function startBooking(id) {
  const product = products.find(p => p.id === id);
  if (!product) return;

  if (!currentUser) {
    pendingBookingId = id;
    chooseAuth("login");
    showAccount();
    message("authMessage", "Login or create an account to continue.");
    return;
  }

  $("bookingProductId").value = id;
  $("bookingProductName").textContent = product.name;

  const today = new Date().toISOString().slice(0, 10);

  $("startDate").min = today;
  $("endDate").min = today;
  $("startDate").value = today;
  $("endDate").value = today;

  $("bookingModal").hidden = false;
}

async function loadBookings() {
  if (!currentUser) {
    showAccount();
    return;
  }

  $("myBookings").hidden = false;
  $("bookingList").textContent = "Loading bookings...";

  try {
    const data = await api("/api/bookings/mine");

    $("bookingList").innerHTML = data.bookings.length
      ? data.bookings.map(b => `
          <div class="booking-row">
            <strong>${escapeHtml(b.product_name)}</strong>
            <p>${escapeHtml(b.start_date)} to ${escapeHtml(b.end_date)}</p>
            <p>Quantity: ${b.quantity}</p>
            <span class="status">${escapeHtml(b.status)}</span>
          </div>
        `).join("")
      : "<p>You have not made any booking requests yet.</p>";

    $("myBookings").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    $("bookingList").textContent = error.message;
  }
}

$("year").textContent = new Date().getFullYear();

$("accountBtn").addEventListener("click", showAccount);
$("closeAccount").addEventListener("click", hideAccount);

$("loginTab").addEventListener("click", () => chooseAuth("login"));
$("registerTab").addEventListener("click", () => chooseAuth("register"));

$("searchInput").addEventListener("input", loadProducts);
$("categorySelect").addEventListener("change", loadProducts);

$("myBookingsBtn").addEventListener("click", loadBookings);

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    currentUser = null;
    await refreshUser();
    chooseAuth("login");
    hideAccount();
  } catch (error) {
    message("authMessage", error.message);
  }
});

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();

  const body = {
    email: $("emailInput").value.trim(),
    password: $("passwordInput").value
  };

  if (authMode === "register") {
    body.name = $("nameInput").value.trim();
  }

  try {
    await api(
      authMode === "login" ? "/api/login" : "/api/register",
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    await refreshUser();

    message("authMessage", "Login successful.", true);

    if (pendingBookingId !== null) {
      const id = pendingBookingId;
      pendingBookingId = null;
      hideAccount();
      startBooking(id);
    } else {
      hideAccount();
    }
  } catch (error) {
    message("authMessage", error.message);
  }
});

$("bookingForm").addEventListener("submit", async event => {
  event.preventDefault();

  try {
    const data = await api("/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        product_id: Number($("bookingProductId").value),
        start_date: $("startDate").value,
        end_date: $("endDate").value,
        quantity: Number($("quantity").value),
        notes: $("bookingNotes").value.trim()
      })
    });

    message(
      "bookingMessage",
      `${data.message} Booking ID: ${data.booking_id}`,
      true
    );

    setTimeout(() => {
      $("bookingModal").hidden = true;
      loadBookings();
    }, 1000);
  } catch (error) {
    message("bookingMessage", error.message);
  }
});

$("closeBooking").addEventListener("click", () => {
  $("bookingModal").hidden = true;
});

$("startDate").addEventListener("change", () => {
  $("endDate").min = $("startDate").value;

  if ($("endDate").value < $("startDate").value) {
    $("endDate").value = $("startDate").value;
  }
});

(async function init() {
  try {
    await loadCategories();
    await loadProducts();
    await refreshUser();
  } catch (error) {
    console.error(error);
  }
})();
