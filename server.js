const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const path = require("path");
const analyzeHandler = require("./api/analyze");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

app.post("/api/analyze", (req, res) => analyzeHandler(req, res));

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
