# CampusMarket

**The marketplace built for your campus community.**

CampusMarket is a modern, real-time campus marketplace where students can buy and sell items, connect with sellers, and build a trusted community — all from one seamless platform.

---

## Why CampusMarket?

Tired of scrolling through generic marketplaces filled with spam and scams? CampusMarket is designed exclusively for students. Every user is part of your campus, every transaction is closer to home, and every feature is built with your needs in mind.

---

## Features

### For Buyers
- **Browse & Search** — Filter by category, price, condition, and location to find exactly what you need
- **Smart Categories** — From textbooks and electronics to fashion and services, everything is organized
- **Favorites** — Save items you love and come back to them later
- **Instant Contact** — Reach sellers with one tap and start a real-time conversation
- **Verified Sellers** — Know who you're buying from with our verification system
- **Reviews & Ratings** — See what other students thought before you buy

### For Sellers
- **List in Seconds** — Drag & drop photos, set your price, and go live instantly
- **Manage Listings** — Edit, update, or mark items as sold
- **Real-time Notifications** — Know the moment someone is interested
- **Seller Dashboard** — Track your listings, sales, and ratings in one place

### For the Community
- **Real-time Chat** — Instant messaging with live typing indicators
- **Online Presence** — See who's online right now
- **System Announcements** — Stay updated with campus-wide notifications
- **Moderation Tools** — Report issues, and our admin team keeps the marketplace safe

---

## How It Works

1. **Sign Up** — Create your account with your campus email
2. **List or Browse** — Sell items you no longer need, or find what you're looking for
3. **Connect** — Chat with sellers, negotiate prices, and arrange pickup
4. **Complete the Sale** — Mark items as sold and let buyers confirm receipt

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js + PostgreSQL |
| Frontend | Vanilla JavaScript SPA |
| Real-time | Server-Sent Events (SSE) |
| Auth | HMAC Token-based Authentication |
| Database | PostgreSQL with auto-migration |

---

## Quick Start

### Prerequisites
- Node.js 16+
- PostgreSQL database (Aiven, Supabase, or local)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-username/campusmarket.git
cd campusmarket

# Install dependencies
npm install

# Set environment variables
export DATABASE_URL="your-postgresql-connection-string"
export SECRET="your-secret-key-at-least-16-chars"
export ADMIN_EMAIL="admin@campus.edu"
export ADMIN_PASSWORD="your-admin-password"

# Start the server
npm start
```

Open `http://localhost:3000` in your browser.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SECRET` | No | Auth secret (auto-generated if not set) |
| `PORT` | No | Server port (default: 3000) |
| `ADMIN_EMAIL` | No | Auto-create admin account |
| `ADMIN_PASSWORD` | No | Admin account password |
| `EMAIL_API_URL` | No | Email service endpoint for verification |
| `EMAIL_API_KEY` | No | Email service API key |

---

## Deployment

### Render
1. Push to GitHub
2. Connect repo on [render.com](https://render.com)
3. Set environment variables
4. Deploy — done!

### Docker
```bash
docker build -t campusmarket .
docker run -p 3000:3000 -e DATABASE_URL="..." campusmarket
```

---

## Security

- Passwords hashed with scrypt (64-byte key)
- HMAC token authentication with timing-safe comparison
- Rate limiting on login attempts
- XSS protection with HTML escaping
- SQL injection prevention with parameterized queries
- Content Security Headers (X-Frame-Options, X-Content-Type-Options)

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

---

## License

MIT License

---

**Built with care for the campus community.** 🎓
