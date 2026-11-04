const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../prisma");
const config = require("../config");
const { AppError } = require("../middleware/error");
const { authenticate } = require("../middleware/auth");
const { sendOtp, verifyOtp, normalizeMobile } = require("../utils/msg91");

const router = express.Router();

const sendTokenCookie = (res, user) => {
  const token = jwt.sign({ id: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: "7d",
  });
  res.cookie("token", token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return token;
};

async function getMainAdminId() {
  const mainAdmin = await prisma.user.findFirst({
    where: {
      OR: [
        { mobile: config.mainAdmin.mobile },
        { email: config.mainAdmin.email },
        { role: "ADMIN" },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return mainAdmin ? mainAdmin.id : null;
}

// 1. Send OTP via MSG91
router.post("/send-otp", async (req, res, next) => {
  try {
    const { mobile, purpose = "Login" } = req.body;
    if (!mobile) {
      throw new AppError("Mobile number is required", 400);
    }

    const cleanMobile = normalizeMobile(mobile);

    // Optional: If purpose is Login, ensure user exists before sending OTP
    if (purpose.toLowerCase() === "login") {
      const existingUser = await prisma.user.findUnique({
        where: { mobile: cleanMobile },
      });
      if (!existingUser && cleanMobile !== config.mainAdmin.mobile) {
        throw new AppError("Mobile number not registered. Please sign up first.", 404);
      }
    }

    const result = await sendOtp(cleanMobile, purpose);
    res.json({
      success: true,
      message: `OTP sent to +91-${result.mobile}`,
      mobile: result.mobile,
      ...(config.nodeEnv !== "production" && result.devOtp ? { devOtp: result.devOtp } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// 2. Verify OTP -> Issues JWT Token ONLY if OTP is valid
router.post("/verify-otp", async (req, res, next) => {
  try {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) {
      throw new AppError("Mobile and OTP are required", 400);
    }

    // Strictly verify OTP first; throws 401 if invalid or expired
    const verifiedMobile = await verifyOtp(mobile, otp);

    const isMainAdminMobile = verifiedMobile === config.mainAdmin.mobile;

    let user = await prisma.user.findUnique({ where: { mobile: verifiedMobile } });

    // Only allow existing registered users (or Main Admin) to log in
    if (!user) {
      if (isMainAdminMobile) {
        user = await prisma.user.create({
          data: {
            name: "Main Admin",
            mobile: verifiedMobile,
            role: "ADMIN",
          },
        });
      } else {
        throw new AppError("Account not found. Please register first.", 404);
      }
    } else if (isMainAdminMobile && user.role !== "ADMIN") {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: "ADMIN" },
      });
    }

    // OTP is verified -> Now issue login token
    const token = sendTokenCookie(res, user);
    const mainAdminId = await getMainAdminId();

    res.json({
      success: true,
      token,
      mainAdminId,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        isMainAdmin: user.id === mainAdminId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 3. Register with Mobile + OTP Verification Required
router.post("/register", async (req, res, next) => {
  try {
    const { name, email, mobile, password, otp } = req.body;

    if (!name || !mobile || !otp) {
      throw new AppError("Name, mobile number, and OTP are required to register", 400);
    }
    if (password && password.length < 6) {
      throw new AppError("Password must be at least 6 characters", 400);
    }

    const cleanEmail = email ? email.trim().toLowerCase() : null;
    const cleanMobile = normalizeMobile(mobile);

    if (cleanEmail && (await prisma.user.findUnique({ where: { email: cleanEmail } }))) {
      throw new AppError("Email already registered", 409);
    }
    if (await prisma.user.findUnique({ where: { mobile: cleanMobile } })) {
      throw new AppError("Mobile number already registered", 409);
    }

    // STRICT CHECK: Verify OTP before creating user or logging in
    await verifyOtp(cleanMobile, otp);

    const isMainAdmin =
      cleanMobile === config.mainAdmin.mobile || cleanEmail === config.mainAdmin.email;

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: cleanEmail,
        mobile: cleanMobile,
        passwordHash,
        role: isMainAdmin ? "ADMIN" : "CUSTOMER",
      },
    });

    const token = sendTokenCookie(res, user);
    const mainAdminId = await getMainAdminId();

    res.status(201).json({
      success: true,
      token,
      mainAdminId,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        isMainAdmin: user.id === mainAdminId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 4. Login Step 1 (Password + OTP) OR Direct OTP Login
router.post("/login", async (req, res, next) => {
  try {
    const { identifier, email, mobile, password, otp } = req.body;
    const loginId = (identifier || email || mobile || "").trim();

    if (!loginId) {
      throw new AppError("Mobile or Email is required", 400);
    }

    const isMobileInput = /^[6-9]\d{9}$/.test(loginId.replace(/\D/g, "").slice(-10));
    const user = await prisma.user.findUnique({
      where: isMobileInput
        ? { mobile: loginId.replace(/\D/g, "").slice(-10) }
        : { email: loginId.toLowerCase() },
    });

    if (!user) {
      throw new AppError("Invalid credentials or user not found", 401);
    }

    // If password is provided, validate it
    if (password) {
      if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new AppError("Invalid credentials", 401);
      }
    }

    // STRICT CHECK: Even if password is valid, DO NOT issue token without OTP
    if (!otp) {
      if (!user.mobile) {
        throw new AppError("No mobile number linked to this account for OTP verification", 400);
      }
      const otpResult = await sendOtp(user.mobile, "Login");
      return res.status(200).json({
        success: true,
        otpRequired: true,
        message: `OTP sent to +91-${otpResult.mobile}. Please verify OTP to complete login.`,
        mobile: otpResult.mobile,
        ...(config.nodeEnv !== "production" && otpResult.devOtp
          ? { devOtp: otpResult.devOtp }
          : {}),
      });
    }

    // Verify OTP before issuing JWT token
    await verifyOtp(user.mobile, otp);

    const token = sendTokenCookie(res, user);
    const mainAdminId = await getMainAdminId();

    res.json({
      success: true,
      token,
      mainAdminId,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        isMainAdmin: user.id === mainAdminId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 5. Logout
router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true, message: "Logged out" });
});

// 6. Get Current Logged-in User
router.get("/me", authenticate, async (req, res, next) => {
  try {
    const mainAdminId = await getMainAdminId();
    res.json({
      success: true,
      mainAdminId,
      user: {
        ...req.user,
        isMainAdmin: req.user.id === mainAdminId,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;