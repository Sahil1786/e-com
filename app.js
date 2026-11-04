const dotenv = require("dotenv");

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");


// 1. Initialize dotenv first so all imported files can read process.env
dotenv.config();

const mainRouter = require("./src/routes/index.js");
const { errorHandler } = require("./src/middleware/error.js");

const app = express();

// 2. Read the port from process.env
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://172.20.10.12:5173",
  "http://192.168.1.34:5173",
  "http://192.168.1.39:5173",
  "http://192.168.1.38:5173",
  "http://192.168.1.41:5173",
  "http://192.168.1.35:5173",
  "https://dashboard.busybox.in",
  "https://utility.busybox.in",
];

const localhostRegex = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;
app.get("/", (req, res) => {
  res.send("Welcome to the BusyBox API!");
});
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin) || localhostRegex.test(origin)) {
        callback(null, true);
      } else {
        console.warn("CORS blocked for origin:", origin);
        return callback(new Error("Not allowed by CORS"), false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 3. Mount main router under /v1
app.use("/v1", mainRouter);


// 4. Central error handler
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});