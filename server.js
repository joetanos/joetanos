// Optional: run the site on your own server (VPS, Render, Railway, etc.)
// Requires Node.js 18+.  Start with:  npm install  then  npm start
const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

app.use("/images", express.static(path.join(__dirname, "images"), { maxAge: "365d" }));
app.use(express.static(__dirname, { index: "index.html" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`Joe Tanos site running on http://localhost:${PORT}`));
