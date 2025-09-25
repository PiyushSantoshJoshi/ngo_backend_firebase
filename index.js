const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

const ngoapp = express();
const PORT = process.env.PORT || 3000;

// Middleware
ngoapp.use(cors());
ngoapp.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

const db = admin.firestore();

ngoapp.post("/registerManyNgos", async (req, res) => {
  try {
    const ngos = req.body.ngos; // Expecting an array of NGO objects

    if (!Array.isArray(ngos) || ngos.length === 0) {
      return res.status(400).json({ message: "NGO list is required" });
    }

    const batch = db.batch();
    const errors = [];

    for (let ngo of ngos) {
      const { name, city, fullAddress, category, registrationId, contact, email, password } = ngo;

      if (!name || !city || !fullAddress || !category || !registrationId || !contact || !email || !password) {
        errors.push({ email, error: "Missing required fields" });
        continue;
      }

      const ngoRef = db.collection("ngos").doc(email);
      const existingNgo = await ngoRef.get();

      if (existingNgo.exists) {
        errors.push({ email, error: "Already exists" });
        continue;
      }

      batch.set(ngoRef, {
        name,
        city,
        fullAddress,
        category,
        registrationId,
        contact,
        email,
        password, // ⚠ Should be hashed in real apps
        status: "pending",
        createdAt: new Date(),
        approvedBy: null
      });
    }

    // Commit all in one go
    await batch.commit();

    res.status(201).json({
      message: "NGO registrations processed",
      errors: errors.length ? errors : null
    });
  } catch (error) {
    console.error("Error registering NGOs:", error);
    res.status(500).json({ message: "Error registering NGOs", error: error.message });
  }
});
// ======================= USER REGISTRATION =======================
ngoapp.post("/registerUser", async (req, res) => {
  try {
    const { email, password } = req.body;
    const userRef = db.collection("users").doc(email);
    const doc = await userRef.get();

    if (doc.exists) return res.status(400).json({ error: "User already exists" });

    await userRef.set({ email, password, role: "user" });
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ======================= NGO REGISTRATION =======================
ngoapp.post("/registerNgo", async (req, res) => {
  try {
    const { name, city, fullAddress, category, registrationId, contact, email, password } = req.body;

    if (!name || !city || !fullAddress || !category || !registrationId || !contact || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const ngoRef = db.collection("ngos").doc(email);
    const existingNgo = await ngoRef.get();

    if (existingNgo.exists) return res.status(400).json({ message: "NGO already registered with this email" });

    // Save in NGOs collection
    await ngoRef.set({
      name,
      city,
      fullAddress,
      category,
      registrationId,
      contact,
      email,
      password, //  plain text, consider hashing
      status: "pending",
      createdAt: new Date(),
      approvedBy: null
    });

    // Also save in users collection for login
    await db.collection("users").doc(email).set({
      email,
      password,
      role: "ngo",
      status: "pending"
    });

    res.status(201).json({ message: "NGO registration submitted. Awaiting admin approval." });
  } catch (error) {
    console.error("Error registering NGO:", error);
    res.status(500).json({ message: "Error registering NGO", error: error.message });
  }
});

// ======================= LOGIN (Users + NGOs) =======================
ngoapp.post("/loginUser", async (req, res) => {
  try {
    const { email, password } = req.body;
    const doc = await db.collection("users").doc(email).get();

    if (!doc.exists) return res.status(400).json({ error: "Invalid credentials" });

    const user = doc.data();

    // Check NGO approval if role is ngo
    if (user.role === "ngo" && user.status !== "approved") {
      return res.status(403).json({ error: "NGO not approved yet" });
    }

    if (password !== user.password) return res.status(400).json({ error: "Invalid credentials" });

    res.json({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// Get user profile
ngoapp.get("/user/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const userDoc = await db.collection("users").doc(email).get();

    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    res.json(userDoc.data());
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Update user profile
ngoapp.put("/user/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const { name, bio, contact, profilePicture } = req.body;

    await db.collection("users").doc(email).update({
      name,
      bio,
      contact,
      profilePicture,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Profile updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ======================= NGO POST REQUIREMENT =======================
ngoapp.post("/ngo/postRequirement", async (req, res) => {
  try {
    const { ngoEmail, item, quantity, description } = req.body;

    const docRef = await db.collection("requirements").add({
      ngoEmail,
      item,
      quantity,
      description, //  include description
      status: "pending", // requires admin approval
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ 
      message: "Requirement submitted for approval",
      requirementId: docRef.id // now defined
    });
    
  } catch (err) {
    console.error("Error posting requirement:", err);
    res.status(500).json({ error: "Failed to post requirement" });
  }
});

// ======================= NGO - APPROVED REQUIREMENTS =======================
ngoapp.get("/ngo/approvedRequirements/:ngoEmail", async (req, res) => {
  try {
    const { ngoEmail } = req.params;
    const snapshot = await db.collection("requirements")
      .where("ngoEmail", "==", ngoEmail)
      .where("status", "==", "approved")
      .get();

    const requirements = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(requirements);
  } catch (err) {
    console.error("Error fetching approved requirements:", err);
    res.status(500).json({ error: "Failed to fetch approved requirements" });
  }
});

// NGO - fetch PENDING requirements
ngoapp.get("/ngo/pendingRequirements/:ngoEmail", async (req, res) => {
  const { ngoEmail } = req.params;
  const snapshot = await db.collection("requirements")
    .where("ngoEmail", "==", ngoEmail)
    .where("status", "==", "pending")
    .get();

  const requirements = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));
  res.json(requirements);
});

// ======================= NGO - REJECTED REQUIREMENTS =======================
ngoapp.get("/ngo/rejectedRequirements/:ngoEmail", async (req, res) => {
  try {
    const { ngoEmail } = req.params;
    const snapshot = await db.collection("requirements")
      .where("ngoEmail", "==", ngoEmail)
      .where("status", "==", "rejected")
      .get();

    const requirements = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json(requirements);
  } catch (err) {
    console.error("Error fetching rejected requirements:", err);
    res.status(500).json({ error: "Failed to fetch rejected requirements" });
  }
});

// ======================= NGO - UPDATE REQUIREMENT =======================
ngoapp.put("/ngo/updateRequirement/:requirementId", async (req, res) => {
  try {
    const { requirementId } = req.params;
    const { item, quantity, description } = req.body;

    // Check if requirement exists and is approved (only allow editing approved requirements)
    const requirementDoc = await db.collection("requirements").doc(requirementId).get();
    
    if (!requirementDoc.exists) {
      return res.status(404).json({ error: "Requirement not found" });
    }

    const requirement = requirementDoc.data();
    
    if (requirement.status !== "approved") {
      return res.status(400).json({ error: "Only approved requirements can be updated" });
    }

    // Update the requirement
    await db.collection("requirements").doc(requirementId).update({
      item,
      quantity,
      description,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Requirement updated successfully" });
  } catch (err) {
    console.error("Error updating requirement:", err);
    res.status(500).json({ error: "Failed to update requirement" });
  }
});

// ======================= SEARCH =======================
ngoapp.get("/searchRequirements", async (req, res) => {
  try {
    const { item } = req.query;
    const snapshot = await db.collection("requirements")
      .where("status", "==", "approved")
      .get();

    let requirements = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (item) {
      requirements = requirements.filter((r) =>
        r.item.toLowerCase().includes(item.toLowerCase())
      );
    }

    res.json(requirements);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

ngoapp.get("/searchNgos", async (req, res) => {
  try {
    const { city, name } = req.query;
    let query = db.collection("ngos").where("status", "==", "approved");
    if (city) query = query.where("city", "==", city);

    const snapshot = await query.get();
    let ngos = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (name) ngos = ngos.filter((ngo) => ngo.name.toLowerCase().includes(name.toLowerCase()));

    res.json(ngos);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// ======================= ADMIN ROUTES =======================
ngoapp.get("/admin/pendingNgos", async (req, res) => {
  try {
    const snapshot = await db.collection("ngos").where("status", "==", "pending").get();
    const ngos = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(ngos);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch pending NGOs" });
  }
});

// ======================= ADMIN - PENDING REQUIREMENTS =======================
ngoapp.get("/admin/pendingRequirements", async (req, res) => {
  try {
    const snapshot = await db.collection("requirements")
      .where("status", "==", "pending")
      .get();

    const requirements = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(requirements);
  } catch (err) {
    console.error("Error fetching pending requirements:", err);
    res.status(500).json({ error: "Failed to fetch pending requirements" });
  }
});

// ======================= ADMIN APPROVE REQUIREMENT =======================
ngoapp.post("/admin/approveRequirement", async (req, res) => {
  try {
    const { requirementId } = req.body;
    await db.collection("requirements").doc(requirementId).update({ status: "approved" });
    res.json({ message: "Requirement approved successfully" });
  } catch (err) {
    res.status(500).json({ error: "Approval failed" });
  }
});


// ======================= ADMIN REJECT REQUIREMENT =======================
ngoapp.post("/admin/rejectRequirement", async (req, res) => {
  try {
    const { requirementId, reason } = req.body;

    await db.collection("requirements").doc(requirementId).update({
      status: "rejected",
      rejectionReason: reason || "Not specified",
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: "Requirement rejected successfully" });
  } catch (err) {
    console.error("Error rejecting requirement:", err);
    res.status(500).json({ error: "Rejection failed" });
  }
});

ngoapp.post("/admin/approveNgo", async (req, res) => {
  try {
    const { ngoId } = req.body;
    await db.collection("ngos").doc(ngoId).update({ status: "approved" });
    // Also update in users collection
    const ngo = await db.collection("users").doc(ngoId).get();
    if (ngo.exists) {
      await db.collection("users").doc(ngoId).update({ status: "approved" });
    }
    res.json({ message: "NGO approved successfully" });
  } catch (err) {
    res.status(500).json({ error: "Approval failed" });
  }
});

// ======================= MESSAGING =======================
ngoapp.post("/messages", async (req, res) => {
  try {
    const { from, to, message } = req.body;
    await db.collection("messages").add({
      from,
      to,
      message,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({ message: "Message sent" });
  } catch (err) {
    res.status(500).json({ error: "Failed to send message" });
  }
});

ngoapp.get("/messages/:withUser", async (req, res) => {
  try {
    const { user } = req.query; // sender (from query param)
    const { withUser } = req.params; // recipient (from URL)
    
    const snapshot = await db.collection("messages")
      .where("from", "in", [user, withUser])
      .where("to", "in", [user, withUser])
      .orderBy("createdAt", "asc")
      .get();
      
    const msgs = snapshot.docs.map((doc) => doc.data());
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Start server
ngoapp.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
