import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";

const app = express();

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  process.env.CLIENT_URL ||
  "http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

const port = process.env.PORT || 5000;
const jwtSecret = process.env.JWT_SECRET || "fixmate_dev_jwt_secret";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

if (!process.env.DB_URL) {
  console.error("Missing DB_URL in environment variables");
}

const client = new MongoClient(process.env.DB_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("fixmate");

const usersCollection = db.collection("user");
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");

const escapeRegex = (str = "") =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

// ==========================================
// Auth & Role Middlewares (Challenge 2)
// ==========================================
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return res.status(401).send({ message: "Unauthorized: Missing token" });
    }

    const decoded = jwt.verify(token, jwtSecret);
    const email = normalizeEmail(decoded.email || "");

    if (!email) {
      return res
        .status(401)
        .send({ message: "Unauthorized: Invalid token payload" });
    }

    const dbUser = await usersCollection.findOne({
      email: new RegExp(`^${escapeRegex(email)}$`, "i"),
    });

    req.user = {
      id: decoded.id || decoded.sub || dbUser?._id?.toString() || "",
      email,
      name: dbUser?.name || decoded.name || "",
      role: String(dbUser?.role || decoded.role || "customer")
        .trim()
        .toLowerCase(),
    };

    next();
  } catch (error) {
    return res
      .status(401)
      .send({ message: "Unauthorized: Invalid or expired token" });
  }
};

const verifyCustomer = (req, res, next) => {
  if (req.user?.role !== "customer") {
    return res.status(403).send({ message: "Forbidden: Customers only" });
  }
  next();
};


// const verifyCustomer = (req, res, next) => {
//   console.log("DEBUG verifyCustomer -> req.user:", req.user);
//   if (req.user?.role !== "customer") {
//     return res.status(403).send({
//       message: "Forbidden: Customers only",
//       debugRole: req.user?.role || null,
//       debugEmail: req.user?.email || null,
//     });
//   }
//   next();
// };




const verifyTechnician = (req, res, next) => {
  if (req.user?.role !== "technician") {
    return res.status(403).send({ message: "Forbidden: Technicians only" });
  }
  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden: Admins only" });
  }
  next();
};

// ==========================================
// Helper: JWT Issue Endpoint (BetterAuth / Login sync)
// ==========================================
app.post("/api/auth/jwt", async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    const normalizedEmail = normalizeEmail(email);
    const dbUser = await usersCollection.findOne({
      email: new RegExp(`^${escapeRegex(normalizedEmail)}$`, "i"),
    });

    const role = String(dbUser?.role || "customer")
      .trim()
      .toLowerCase();

    const token = jwt.sign(
      {
        id: dbUser?._id?.toString() || "",
        email: normalizedEmail,
        name: dbUser?.name || name || "",
        role,
      },
      jwtSecret,
      { expiresIn: "7d" }
    );

    res.send({ token, role, email: normalizedEmail });
  } catch (error) {
    console.error("JWT issue error:", error);
    res.status(500).send({ message: "Failed to issue token" });
  }
});

// =========================================
// Root & Public Service Routes
// ==========================================
app.get("/", (req, res) => {
  res.send("FixMate server is running");
});

// 1. Approved & Available সার্ভিসগুলো আনা (Search, Filter, Sort)
app.get("/services", async (req, res) => {
  try {
    const { search, category, serviceMode, sort, limit } = req.query;

    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    if (search && String(search).trim() !== "") {
      const searchRegex = new RegExp(escapeRegex(String(search).trim()), "i");
      query.$or = [
        { title: { $regex: searchRegex } },
        { category: { $regex: searchRegex } },
      ];
    }

    if (category && category !== "All") {
      query.category = new RegExp(
        `^${escapeRegex(String(category).trim())}$`,
        "i"
      );
    }

    if (serviceMode && serviceMode !== "All") {
      query.serviceMode = serviceMode;
    }

    let sortOption = { createdAt: -1 };
    if (sort === "price_asc") {
      sortOption = { basePrice: 1 };
    } else if (sort === "price_desc") {
      sortOption = { basePrice: -1 };
    }

    let cursor = servicesCollection.find(query).sort(sortOption);

    if (limit) {
      const parsedLimit = parseInt(String(limit), 10);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        cursor = cursor.limit(parsedLimit);
      }
    }

    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching services:", error);
    res.status(500).send({ message: "Failed to load services" });
  }
});

// 2. একটি নির্দিষ্ট সার্ভিসের ডিটেইলস ও টেকনিশিয়ানের সামারি আনা
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID" });
    }

    const service = await servicesCollection.findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }

    let technicianSummary = {
      technicianName: service.technicianName || "Verified Technician",
      technicianPhoto: service.technicianPhoto || "",
      technicianArea:
        service.technicianArea || service.serviceArea || "Local Service Area",
      technicianBio:
        service.technicianBio ||
        "Certified repair specialist with experience in fast diagnostics and reliable service.",
    };

    if (service.technicianEmail) {
      const techUser = await usersCollection.findOne({
        email: new RegExp(
          `^${escapeRegex(service.technicianEmail.trim())}$`,
          "i"
        ),
      });

      if (techUser) {
        technicianSummary = {
          technicianName:
            service.technicianName || techUser.name || "Verified Technician",
          technicianPhoto:
            service.technicianPhoto || techUser.image || techUser.photo || "",
          technicianArea:
            service.technicianArea ||
            techUser.area ||
            techUser.serviceArea ||
            service.serviceArea ||
            "Local Service Area",
          technicianBio:
            service.technicianBio ||
            techUser.bio ||
            "Certified repair specialist with experience in fast diagnostics and reliable service.",
        };
      }
    }

    res.send({
      ...service,
      ...technicianSummary,
    });
  } catch (error) {
    console.error("Error fetching service details:", error);
    res.status(500).send({ message: "Failed to load service details" });
  }
});

// ==========================================
// Technician Service Routes (Protected)
// ==========================================
// 3. টেকনিশিয়ানের নিজের সব সার্ভিস আনা
app.get(
  "/services/technician/:email",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const requestedEmail = normalizeEmail(
        decodeURIComponent(req.params.email || "")
      );

      if (!requestedEmail || requestedEmail !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You can only view your own services" });
      }

      const services = await servicesCollection
        .find({
          technicianEmail: new RegExp(
            `^${escapeRegex(req.user.email)}$`,
            "i"
          ),
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(services);
    } catch (error) {
      console.error("Error fetching technician services:", error);
      res.status(500).send({ message: "Failed to load technician services" });
    }
  }
);

// 4. নতুন সার্ভিস তৈরি করা (Technician Add Service)
app.post("/services", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
      technicianName,
    } = req.body;

    if (!title || !category || !basePrice || !serviceMode) {
      return res.status(400).send({
        message: "Title, category, basePrice, and serviceMode are required",
      });
    }

    const numericPrice = Number(basePrice);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).send({
        message: "Base price must be a positive number",
      });
    }

    const newService = {
      title: String(title).trim(),
      category: String(category).trim(),
      description: description ? String(description).trim() : "",
      image:
        image && String(image).trim() !== ""
          ? String(image).trim()
          : "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=800",
      basePrice: numericPrice,
      estimatedDuration: estimatedDuration
        ? String(estimatedDuration).trim()
        : "1-2 hours",
      serviceMode,
      serviceArea: serviceArea ? String(serviceArea).trim() : "",
      technicianName: technicianName || req.user.name || "",
      technicianEmail: req.user.email,
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: new Date(),
    };

    const result = await servicesCollection.insertOne(newService);
    res.status(201).send({
      message: "Service created with pending approval",
      insertedId: result.insertedId,
      service: { ...newService, _id: result.insertedId },
    });
  } catch (error) {
    console.error("Error creating service:", error);
    res.status(500).send({ message: "Failed to create service" });
  }
});

// 5. সার্ভিসের availability (isAvailable: true/false) আপডেট করা
app.patch(
  "/services/:id/availability",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isAvailable } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid service ID" });
      }

      const existingService = await servicesCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!existingService) {
        return res.status(404).send({ message: "Service not found" });
      }

      if (normalizeEmail(existingService.technicianEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this service" });
      }

      const result = await servicesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isAvailable: Boolean(isAvailable), updatedAt: new Date() } }
      );

      res.send(result);
    } catch (error) {
      console.error("Error updating service availability:", error);
      res.status(500).send({ message: "Failed to update availability" });
    }
  }
);

// 6. সার্ভিস এডিট / আপডেট করা (এডিট করলে approvalStatus আবার 'pending' হবে)
app.patch("/services/:id", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID" });
    }

    const existingService = await servicesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!existingService) {
      return res.status(404).send({ message: "Service not found" });
    }

    if (normalizeEmail(existingService.technicianEmail) !== req.user.email) {
      return res
        .status(403)
        .send({ message: "Forbidden: You do not own this service" });
    }

    const {
      title,
      category,
      description,
      image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
    } = req.body;

    let parsedPrice;
    if (basePrice !== undefined) {
      parsedPrice = Number(basePrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        return res
          .status(400)
          .send({ message: "Base price must be a positive number" });
      }
    }

    const updateFields = {
      ...(title !== undefined ? { title: String(title).trim() } : {}),
      ...(category !== undefined ? { category: String(category).trim() } : {}),
      ...(description !== undefined
        ? { description: String(description).trim() }
        : {}),
      ...(image !== undefined ? { image: String(image).trim() } : {}),
      ...(parsedPrice !== undefined ? { basePrice: parsedPrice } : {}),
      ...(estimatedDuration !== undefined
        ? { estimatedDuration: String(estimatedDuration).trim() }
        : {}),
      ...(serviceMode !== undefined ? { serviceMode } : {}),
      ...(serviceArea !== undefined
        ? { serviceArea: String(serviceArea).trim() }
        : {}),
      approvalStatus: "pending",
      updatedAt: new Date(),
    };

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );

    res.send(result);
  } catch (error) {
    console.error("Error updating service:", error);
    res.status(500).send({ message: "Failed to update service" });
  }
});

// 7. সার্ভিস ডিলিট করা
app.delete("/services/:id", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid service ID" });
    }

    const existingService = await servicesCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!existingService) {
      return res.status(404).send({ message: "Service not found" });
    }

    if (normalizeEmail(existingService.technicianEmail) !== req.user.email) {
      return res
        .status(403)
        .send({ message: "Forbidden: You do not own this service" });
    }

    const result = await servicesCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.error("Error deleting service:", error);
    res.status(500).send({ message: "Failed to delete service" });
  }
});

// 8. নতুন বুকিং তৈরি করা (শুধু Customer রিকোয়েস্ট করতে পারবে)
app.post("/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const booking = req.body;

    if (!booking.serviceId) {
      return res.status(400).send({ message: "serviceId is required" });
    }

    const customerEmail = req.user.email;

    if (
      booking.technicianEmail &&
      normalizeEmail(booking.technicianEmail) === customerEmail
    ) {
      return res
        .status(403)
        .send({ message: "You cannot request your own service" });
    }

    let serviceDoc = null;
    if (ObjectId.isValid(String(booking.serviceId).trim())) {
      serviceDoc = await servicesCollection.findOne({
        _id: new ObjectId(String(booking.serviceId).trim()),
      });
    }

    if (
      serviceDoc?.technicianEmail &&
      normalizeEmail(serviceDoc.technicianEmail) === customerEmail
    ) {
      return res
        .status(403)
        .send({ message: "You cannot request your own service" });
    }

    const existingActive = await bookingsCollection.findOne({
      serviceId: String(booking.serviceId).trim(),
      customerEmail: new RegExp(`^${escapeRegex(customerEmail)}$`, "i"),
      status: { $in: ["requested", "accepted", "in-progress"] },
    });

    if (existingActive) {
      return res.status(409).send({
        message: "You already have an active request for this service",
      });
    }

    const resolvedBasePrice = Number(
      booking.basePrice ?? serviceDoc?.basePrice ?? 0
    );

    const now = new Date();
    const newBooking = {
      ...booking,
      serviceTitle: booking.serviceTitle || serviceDoc?.title || "",
      serviceImage: booking.serviceImage || serviceDoc?.image || "",
      category: booking.category || serviceDoc?.category || "",
      technicianName:
        booking.technicianName || serviceDoc?.technicianName || "",
      technicianEmail: normalizeEmail(
        booking.technicianEmail || serviceDoc?.technicianEmail || ""
      ),
      customerName: booking.customerName || req.user.name || "",
      customerEmail,
      basePrice: resolvedBasePrice,
      status: "requested",
      finalAmount: resolvedBasePrice,
      paymentStatus: "unpaid",
      statusHistory: [{ status: "requested", changedAt: now }],
      createdAt: now,
    };

    const result = await bookingsCollection.insertOne(newBooking);
    res.status(201).send({
      message: "Booking request created",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Error creating booking:", error);
    res.status(500).send({ message: "Failed to create booking" });
  }
});

// 9. নির্দিষ্ট কাস্টমারের সব বুকিং আনা
const getCustomerBookingsHandler = async (req, res) => {
  try {
    const targetEmail = req.params.email
      ? normalizeEmail(decodeURIComponent(req.params.email))
      : req.user.email;

    if (!targetEmail || targetEmail !== req.user.email) {
      return res
        .status(403)
        .send({ message: "Forbidden: You can only view your own bookings" });
    }

    const bookings = await bookingsCollection
      .find({
        customerEmail: new RegExp(`^${escapeRegex(req.user.email)}$`, "i"),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("Error fetching customer bookings:", error);
    res.status(500).send({ message: "Failed to load bookings" });
  }
};

app.get(
  "/bookings/customer/:email",
  verifyToken,
  verifyCustomer,
  getCustomerBookingsHandler
);
app.get("/bookings/my", verifyToken, verifyCustomer, getCustomerBookingsHandler);

// 10. নির্দিষ্ট টেকনিশিয়ানের সব বুকিং রিকোয়েস্ট আনা
const getTechnicianBookingsHandler = async (req, res) => {
  try {
    const targetEmail = req.params.email
      ? normalizeEmail(decodeURIComponent(req.params.email))
      : req.user.email;

    if (!targetEmail || targetEmail !== req.user.email) {
      return res
        .status(403)
        .send({ message: "Forbidden: You can only view your own requests" });
    }

    const requests = await bookingsCollection
      .find({
        technicianEmail: new RegExp(`^${escapeRegex(req.user.email)}$`, "i"),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(requests);
  } catch (error) {
    console.error("Error fetching technician bookings:", error);
    res.status(500).send({ message: "Failed to load technician bookings" });
  }
};

app.get(
  "/bookings/technician/:email",
  verifyToken,
  verifyTechnician,
  getTechnicianBookingsHandler
);
app.get(
  "/bookings/technician",
  verifyToken,
  verifyTechnician,
  getTechnicianBookingsHandler
);

// 11. বুকিং স্ট্যাটাস আপডেট করা (Strict Pipeline - Challenge 3)
app.patch(
  "/bookings/:id/status",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, finalAmount } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid booking ID" });
      }

      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      if (normalizeEmail(booking.technicianEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Only the assigned technician can update this job" });
      }

      const currentStatus = booking.status;
      const allowedTransitions = {
        requested: ["accepted", "rejected"],
        accepted: ["in-progress"],
        "in-progress": ["completed"],
        completed: [],
        rejected: [],
        cancelled: [],
      };

      const nextAllowed = allowedTransitions[currentStatus] || [];
      if (!nextAllowed.includes(status)) {
        return res.status(400).send({
          message: `Invalid status transition from '${currentStatus}' to '${status}'`,
        });
      }

      const updateFields = {
        status,
        updatedAt: new Date(),
      };

      if (status === "completed") {
        const numericFinal = Number(finalAmount);
        if (!Number.isFinite(numericFinal) || numericFinal <= 0) {
          return res.status(400).send({
            message:
              "finalAmount must be a number greater than 0 when completing a job",
          });
        }
        updateFields.finalAmount = numericFinal;
      }

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updateFields,
          $push: {
            statusHistory: {
              status,
              changedAt: new Date(),
            },
          },
        }
      );

      res.send(result);
    } catch (error) {
      console.error("Booking status update error:", error);
      res.status(500).send({ message: "Failed to update booking status" });
    }
  }
);

// 14. কাস্টমারের বুকিং ক্যান্সেল করা (শুধু 'requested' অবস্থায় ও নিজের বুকিং)
app.patch(
  "/bookings/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid booking ID" });
      }

      const existingBooking = await bookingsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!existingBooking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      if (normalizeEmail(existingBooking.customerEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You can only cancel your own booking" });
      }

      if (existingBooking.status !== "requested") {
        return res.status(400).send({
          message: "Only requested bookings can be cancelled",
        });
      }

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
          $push: {
            statusHistory: {
              status: "cancelled",
              changedAt: new Date(),
            },
          },
        }
      );

      res.send(result);
    } catch (error) {
      console.error("Error cancelling booking:", error);
      res.status(500).send({ message: "Failed to cancel booking" });
    }
  }
);


// 12. ইউজারের প্রোফাইল তথ্য আনা
app.get("/users/:email", verifyToken, async (req, res) => {
  try {
    const email = normalizeEmail(decodeURIComponent(req.params.email || ""));
    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    if (email !== req.user.email && req.user.role !== "admin") {
      return res
        .status(403)
        .send({ message: "Forbidden: You can only view your own profile" });
    }

    const user = await usersCollection.findOne({
      email: new RegExp(`^${escapeRegex(email)}$`, "i"),
    });
    res.send(user || {});
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).send({ message: "Failed to fetch user" });
  }
});

// 13. ইউজারের প্রোফাইল তথ্য আপডেট করা
const updateProfileHandler = async (req, res) => {
  try {
    const targetEmail = req.params.email
      ? normalizeEmail(decodeURIComponent(req.params.email))
      : req.user.email;

    if (!targetEmail || targetEmail !== req.user.email) {
      return res
        .status(403)
        .send({ message: "Forbidden: You can only update your own profile" });
    }

    const { name, phone, serviceArea, area, specialty, bio, image } = req.body;
    const resolvedArea = serviceArea || area || "";

    const updateDoc = {
      $set: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        phone: phone || "",
        serviceArea: resolvedArea,
        area: resolvedArea,
        specialty: specialty || "",
        bio: bio || "",
        ...(image ? { image } : {}),
        updatedAt: new Date(),
      },
    };

    const result = await usersCollection.updateOne(
      { email: new RegExp(`^${escapeRegex(req.user.email)}$`, "i") },
      updateDoc,
      { upsert: true }
    );

    res.send(result);
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).send({ message: "Failed to update user" });
  }
};

app.patch("/users/:email", verifyToken, updateProfileHandler);
app.patch("/api/users/profile", verifyToken, updateProfileHandler);

app.get("/admin/services", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    if (status && status !== "all") {
      query.approvalStatus = status;
    }

    const services = await servicesCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const sorted = services.sort((a, b) => {
      if (a.approvalStatus === "pending" && b.approvalStatus !== "pending")
        return -1;
      if (a.approvalStatus !== "pending" && b.approvalStatus === "pending")
        return 1;
      return 0;
    });

    res.send(sorted);
  } catch (error) {
    console.error("Error fetching admin services:", error);
    res.status(500).send({ message: "Failed to load services" });
  }
});

// 16. সার্ভিস Approve বা Reject করা
app.patch(
  "/admin/services/:id/approval",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { approvalStatus } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid service ID" });
      }

      if (!["approved", "rejected", "pending"].includes(approvalStatus)) {
        return res.status(400).send({ message: "Invalid approval status" });
      }

      const result = await servicesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            approvalStatus,
            updatedAt: new Date(),
          },
        }
      );

      res.send(result);
    } catch (error) {
      console.error("Error updating service approval:", error);
      res.status(500).send({ message: "Failed to update service approval" });
    }
  }
);

// 19. অ্যাডমিনের জন্য সব ইউজার আনা
app.get("/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.send(users);
  } catch (error) {
    console.error("Error fetching admin users:", error);
    res.status(500).send({ message: "Failed to load users" });
  }
});

// 20. অ্যাডমিন কর্তৃক ইউজারের রোল পরিবর্তন (নিজের রোল নিজে পরিবর্তন করতে পারবে না)
app.patch(
  "/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid user ID" });
      }

      if (!["customer", "technician", "admin"].includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      const targetUser = await usersCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!targetUser) {
        return res.status(404).send({ message: "User not found" });
      }

      if (
        targetUser.email &&
        normalizeEmail(targetUser.email) === req.user.email
      ) {
        return res
          .status(403)
          .send({ message: "Admin cannot change their own role" });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role, updatedAt: new Date() } }
      );

      res.send(result);
    } catch (error) {
      console.error("Error updating user role:", error);
      res.status(500).send({ message: "Failed to update user role" });
    }
  }
);

// 21. অ্যাডমিনের জন্য সব বুকিং আনা (Read-only + status filter)
app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};

    if (status && status !== "all") {
      query.status = String(status).trim();
    }

    const bookings = await bookingsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("Error fetching admin bookings:", error);
    res.status(500).send({ message: "Failed to load bookings" });
  }
});

// 22. অ্যাডমিনের জন্য সব ট্রানজেকশন আনা
app.get("/admin/payments", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payments = await paymentsCollection
      .find({})
      .sort({ paidAt: -1 })
      .toArray();

    res.send(payments);
  } catch (error) {
    console.error("Error fetching admin payments:", error);
    res.status(500).send({ message: "Failed to load transactions" });
  }
});

// ==========================================
// Stripe Payment & Payment History Routes
// ==========================================
// Stripe Checkout Session তৈরি করা (completed + unpaid ও নিজের বুকিংয়ের জন্য)
app.post(
  "/api/payments/create-checkout-session",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      if (!stripe) {
        return res
          .status(500)
          .send({ message: "Stripe secret key is not configured on server" });
      }

      const { bookingId } = req.body;
      if (!bookingId || !ObjectId.isValid(bookingId)) {
        return res.status(400).send({ message: "Valid bookingId is required" });
      }

      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(bookingId),
      });

      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      if (normalizeEmail(booking.customerEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You can only pay for your own booking" });
      }

      if (booking.status !== "completed" || booking.paymentStatus === "paid") {
        return res.status(400).send({
          message: "Payment is only allowed for completed and unpaid bookings",
        });
      }

      const amountDollars = Number(
        booking.finalAmount ?? booking.basePrice ?? 0
      );
      const unitAmountCents = Math.round(amountDollars * 100);

      if (!Number.isFinite(unitAmountCents) || unitAmountCents <= 0) {
        return res.status(400).send({ message: "Invalid payment amount" });
      }

      const baseClientUrl =
        process.env.CLIENT_URL || clientUrl || "http://localhost:3000";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: booking.customerEmail,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: booking.serviceTitle || "FixMate Repair Service",
              },
              unit_amount: unitAmountCents,
            },
            quantity: 1,
          },
        ],
        metadata: {
          bookingId: booking._id.toString(),
          customerEmail: booking.customerEmail,
        },
        success_url: `${baseClientUrl}/customer/payments/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseClientUrl}/customer/payments/cancel`,
      });

      res.send({ url: session.url, sessionId: session.id });
    } catch (error) {
      console.error("Stripe checkout session error:", error);
      res
        .status(500)
        .send({ message: "Failed to create Stripe checkout session" });
    }
  }
);

// Stripe Payment ভেরিফাই করা ও ডুপ্লিকেট ছাড়া সেভ করা
app.get("/api/payments/verify", verifyToken, async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .send({ message: "Stripe secret key is not configured on server" });
    }

    const { session_id: sessionId } = req.query;
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).send({ message: "session_id is required" });
    }

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

    const sessionCustomerEmail = normalizeEmail(
      checkoutSession.metadata?.customerEmail ||
        checkoutSession.customer_email ||
        ""
    );

    if (
      sessionCustomerEmail &&
      sessionCustomerEmail !== req.user.email &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send({
        message: "Forbidden: You cannot verify another user's payment",
      });
    }

    if (checkoutSession.payment_status !== "paid") {
      return res
        .status(400)
        .send({ message: "Payment is not completed yet", paid: false });
    }

    const existingPayment = await paymentsCollection.findOne({
      stripeSessionId: checkoutSession.id,
    });

    if (existingPayment) {
      return res.send({
        success: true,
        alreadyRecorded: true,
        transactionId: existingPayment.transactionId,
        amount: existingPayment.amount,
        payment: existingPayment,
      });
    }

    const bookingId = checkoutSession.metadata?.bookingId;
    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res
        .status(400)
        .send({ message: "Invalid bookingId in session metadata" });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    if (booking.paymentStatus === "paid") {
      const existingByBooking = await paymentsCollection.findOne({
        bookingId: String(bookingId),
      });
      return res.send({
        success: true,
        alreadyRecorded: true,
        transactionId: existingByBooking?.transactionId || booking.transactionId,
        amount:
          existingByBooking?.amount ??
          Number(booking.finalAmount ?? booking.basePrice ?? 0),
        payment: existingByBooking || null,
      });
    }

    const paidAt = new Date();
    const amount =
      Number(booking.finalAmount ?? booking.basePrice ?? 0) ||
      Number((checkoutSession.amount_total || 0) / 100);
    const transactionId =
      typeof checkoutSession.payment_intent === "string"
        ? checkoutSession.payment_intent
        : checkoutSession.payment_intent?.id || `PI-${Date.now()}`;

    await bookingsCollection.updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          paymentStatus: "paid",
          transactionId,
          paidAt,
          updatedAt: paidAt,
        },
      }
    );

    const paymentRecord = {
      bookingId: String(bookingId),
      serviceTitle: booking.serviceTitle || "Repair Service",
      category: booking.category || "Repair",
      customerName: booking.customerName || "Customer",
      customerEmail: normalizeEmail(
        checkoutSession.metadata?.customerEmail || booking.customerEmail || ""
      ),
      technicianName: booking.technicianName || "Technician",
      technicianEmail: normalizeEmail(booking.technicianEmail || ""),
      amount,
      currency: "usd",
      transactionId,
      stripeSessionId: checkoutSession.id,
      paymentStatus: "paid",
      paidAt,
    };

    await paymentsCollection.insertOne(paymentRecord);

    res.send({
      success: true,
      transactionId,
      amount,
      payment: paymentRecord,
    });
  } catch (error) {
    console.error("Stripe payment verify error:", error);
    res.status(500).send({ message: "Failed to verify Stripe payment" });
  }
});

// 17. বুকিংয়ের পেমেন্ট সম্পন্ন করা ও ট্রানজেকশন সেভ করা (Fallback manual/local pay)
app.patch(
  "/bookings/:id/pay",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { paymentMethod = "Card" } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid booking ID" });
      }

      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      if (normalizeEmail(booking.customerEmail) !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You can only pay for your own booking" });
      }

      if (booking.status !== "completed") {
        return res.status(400).send({
          message: "Booking must be completed before payment",
        });
      }

      if (booking.paymentStatus === "paid") {
        return res.status(400).send({ message: "Booking is already paid" });
      }

      const amount = Number(booking.finalAmount ?? booking.basePrice ?? 0);
      const transactionId = `TXN-${Date.now()}-${Math.floor(
        1000 + Math.random() * 9000
      )}`;
      const paidAt = new Date();

      await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            paymentStatus: "paid",
            transactionId,
            paidAt,
            updatedAt: paidAt,
          },
        }
      );

      const paymentRecord = {
        bookingId: id,
        transactionId,
        serviceTitle: booking.serviceTitle,
        category: booking.category || "Repair",
        customerName: booking.customerName,
        customerEmail: normalizeEmail(booking.customerEmail),
        technicianName: booking.technicianName || "Technician",
        technicianEmail: normalizeEmail(booking.technicianEmail || ""),
        amount,
        currency: "usd",
        paymentMethod,
        paymentStatus: "paid",
        paidAt,
      };

      await paymentsCollection.insertOne(paymentRecord);

      res.send({
        success: true,
        transactionId,
        amount,
        payment: paymentRecord,
      });
    } catch (error) {
      console.error("Payment processing error:", error);
      res.status(500).send({ message: "Failed to process payment" });
    }
  }
);

// 18. কাস্টমারের পেমেন্ট হিস্ট্রি আনা
const getCustomerPaymentsHandler = async (req, res) => {
  try {
    const email = normalizeEmail(decodeURIComponent(req.params.email || ""));

    if (!email) {
      return res.status(400).send({ message: "Customer email is required" });
    }

    if (email !== req.user.email && req.user.role !== "admin") {
      return res
        .status(403)
        .send({ message: "Forbidden: You can only view your own payments" });
    }

    const payments = await paymentsCollection
      .find({
        customerEmail: new RegExp(`^${escapeRegex(email)}$`, "i"),
      })
      .sort({ paidAt: -1 })
      .toArray();

    res.send(payments);
  } catch (error) {
    console.error("Error fetching customer payments:", error);
    res.status(500).send({ message: "Failed to fetch payment history" });
  }
};

app.get(
  "/api/payments/customer/:email",
  verifyToken,
  getCustomerPaymentsHandler
);
app.get("/payments/customer/:email", verifyToken, getCustomerPaymentsHandler);

// --Export middlewares for modular route usage if needed
export { verifyToken, verifyCustomer, verifyTechnician, verifyAdmin };

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

export default app