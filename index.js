import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";

const app = express();

app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;

const client = new MongoClient(process.env.DB_URL);

export async function connectToMongoDB() {
  await client.connect();
  console.log("You successfully connected to MongoDB!");
  return client;
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("fixmate");

const usersCollection = db.collection("user");
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");

app.get("/", (req, res) => {
  res.send("FixMate server is running");
});

app.get("/services", async (req, res) => {
  const { search, category, serviceMode, sort, limit } = req.query;

  const query = {
    approvalStatus: "approved",
    isAvailable: true,
  };

  if (search && search.trim() !== "") {
    const searchRegex = new RegExp(search.trim(), "i");
    query.$or = [
      { title: { $regex: searchRegex } },
      { category: { $regex: searchRegex } },
    ];
  }

  if (category && category !== "All") {
    query.category = new RegExp(`^${category.trim()}$`, "i");
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
    cursor = cursor.limit(parseInt(limit, 10));
  }

  const result = await cursor.toArray();
  res.send(result);
});

// 2. একটি নির্দিষ্ট সার্ভিসের ডিটেইলস আনা
app.get("/services/:id", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }

  const service = await servicesCollection.findOne({ _id: new ObjectId(id) });

  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }

  res.send(service);
});

// 3. টেকনিশিয়ানের নিজের সব সার্ভিস আনা (pending, approved, rejected সবই আসবে)
app.get("/services/technician/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim();

  const services = await servicesCollection
    .find({
      technicianEmail: {
        $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(services);
});

// 4. নতুন সার্ভিস তৈরি করা (Technician Add Service)
app.post("/services", async (req, res) => {
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
    technicianEmail,
  } = req.body;

  if (!title || !category || !basePrice || !serviceMode) {
    return res.status(400).send({
      message: "Title, category, basePrice, and serviceMode are required",
    });
  }

  const newService = {
    title: title.trim(),
    category: category.trim(),
    description: description ? description.trim() : "",
    image:
      image && image.trim() !== ""
        ? image.trim()
        : "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=800",
    basePrice: Number(basePrice),
    estimatedDuration: estimatedDuration
      ? estimatedDuration.trim()
      : "1-2 hours",
    serviceMode,
    serviceArea: serviceArea ? serviceArea.trim() : "",
    technicianName: technicianName || "",
    technicianEmail: technicianEmail || "",
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
});

// 5. সার্ভিসের availability (isAvailable: true/false) আপডেট করা
app.patch("/services/:id/availability", async (req, res) => {
  const { id } = req.params;
  const { isAvailable } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }

  const result = await servicesCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isAvailable: Boolean(isAvailable), updatedAt: new Date() } }
  );

  res.send(result);
});

// সার্ভিস এডিট / আপডেট করা (এডিট করলে approvalStatus আবার 'pending' হবে)
app.patch("/services/:id", async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service ID" });
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

  const updateFields = {
    ...(title !== undefined ? { title: String(title).trim() } : {}),
    ...(category !== undefined ? { category: String(category).trim() } : {}),
    ...(description !== undefined
      ? { description: String(description).trim() }
      : {}),
    ...(image !== undefined ? { image: String(image).trim() } : {}),
    ...(basePrice !== undefined ? { basePrice: Number(basePrice) } : {}),
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
});

// 6. সার্ভিস ডিলিট করা
app.delete("/services/:id", async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }

  const result = await servicesCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});

// 7. নতুন বুকিং তৈরি করা (Customer বুক করলে এই রাউট ব্যবহার হবে)
app.post("/bookings", async (req, res) => {
  const booking = req.body;

  if (!booking.serviceId || !booking.customerEmail) {
    return res
      .status(400)
      .send({ message: "serviceId and customerEmail are required" });
  }

  const existingActive = await bookingsCollection.findOne({
    serviceId: String(booking.serviceId),
    customerEmail: String(booking.customerEmail).trim(),
    status: { $in: ["requested", "accepted", "in-progress"] },
  });

  if (existingActive) {
    return res.status(409).send({
      message: "You already have an active request for this service",
    });
  }

  const newBooking = {
    ...booking,
    status: "requested",
    paymentStatus: booking.paymentStatus || "unpaid",
    createdAt: new Date(),
  };

  const result = await bookingsCollection.insertOne(newBooking);
  res.status(201).send({
    message: "Booking request created",
    insertedId: result.insertedId,
  });
});

// 8. নির্দিষ্ট কাস্টমারের সব বুকিং আনা (My Bookings পেজের জন্য)
app.get("/bookings/customer/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim();

    const bookings = await bookingsCollection
      .find({
        customerEmail: {
          $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("Error fetching customer bookings:", error);
    res.status(500).send({ message: "Failed to load bookings" });
  }
});

// 9. নির্দিষ্ট টেকনিশিয়ানের সব বুকিং রিকোয়েস্ট আনা
app.get("/bookings/technician/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim();

  const requests = await bookingsCollection
    .find({
      technicianEmail: {
        $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        $options: "i",
      },
    })
    .sort({ createdAt: -1 })
    .toArray();

  res.send(requests);
});

// 10. বুকিং স্ট্যাটাস আপডেট করা (Accept, In Progress, Complete, Reject)
app.patch("/bookings/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, finalAmount } = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }

  const updateFields = {
    status,
    ...(typeof finalAmount === "number" && !Number.isNaN(finalAmount)
      ? { finalAmount }
      : {}),
    updatedAt: new Date(),
  };

  const result = await bookingsCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: updateFields }
  );

  res.send(result);
});

// 11. ইউজারের প্রোফাইল তথ্য আনা (Settings পেজের জন্য)
app.get("/users/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const user = await usersCollection.findOne({ email });
  res.send(user || {});
});

// 12. ইউজারের প্রোফাইল তথ্য আপডেট করা
app.patch("/users/:email", async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { name, phone, serviceArea, specialty, bio, image } = req.body;

  const updateDoc = {
    $set: {
      name,
      phone: phone || "",
      serviceArea: serviceArea || "",
      specialty: specialty || "",
      bio: bio || "",
      ...(image ? { image } : {}),
      updatedAt: new Date(),
    },
  };

  const result = await usersCollection.updateOne({ email }, updateDoc, {
    upsert: true,
  });

  res.send(result);
});

// 13. কাস্টমারের বুকিং ক্যান্সেল করা (শুধু 'requested' অবস্থায়)
app.patch("/bookings/:id/cancel", async (req, res) => {
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
    }
  );

  res.send(result);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});