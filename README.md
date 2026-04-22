# restaurant-voice-ai-solutions
Our restaurant misses out on 30% of to go orders due to high call volume and staff busy-ness
This also slows down our bartenders who have to take every to go order sometimes multiple at once.

## The Solution: 
An A.I powered voice agent integrated with Salesforce to handle the following:

- FAQ's
- hours
- location
- menu 
- capture order leads.
- answer general questions.

## Roadmap
1. Build lead intake object in salesforce.

# 🤖 Salesforce AI Agent (VPS Prototype)

## 📅 Day 1 Progress

This project is in early development. Day 1 focused on establishing a working foundation for connecting a VPS-hosted Python backend to Salesforce using OAuth 2.0.

The long-term goal is to build an AI-driven system capable of interacting with Salesforce CRM data (Leads, Contacts, Tasks), with future expansion into voice-based automation.

---

## 🎯 Project Objective

Build a backend AI agent that:

- Connects securely to Salesforce via API
- Authenticates using OAuth 2.0
- Enables programmatic CRM actions (Lead creation, updates, queries)
- Serves as the foundation for future AI + voice automation workflows

---

## ⚙️ Environment Setup

- Linux VPS (Hostinger) configured as execution environment
- Python 3 installed with virtual environment (`venv`)
- Project directory initialized
- Core dependency installed:
  - `requests`

---

## 🔐 Salesforce Setup

- Salesforce External Client App created
- OAuth 2.0 Authorization Code Flow configured
- Consumer Key and Consumer Secret generated
- OAuth scopes enabled:
  - `api`
  - `refresh_token`
  - `full`

- Environment identified as Salesforce Developer Edition
- OAuth endpoints aligned with:
  - `test.salesforce.com`

---

## 🔄 Authentication Work Completed

Implemented initial OAuth 2.0 flow:

### `oauth_login.py`
- Launches Salesforce login in browser
- Requests user authorization
- Captures authorization code from redirect URL

### `get_token.py`
- Exchanges authorization code for:
  - access token
  - refresh token
  - instance URL

---

## 🧪 Issues Encountered

### 1. OAuth Flow Iteration & Debugging
- Multiple authentication attempts required to align Salesforce configuration with VPS environment
- Authorization code handling validated

### 2. Client Credential Mismatches
- Encountered `invalid_client` and `invalid_client_id` errors during testing
- Root cause: mismatched or incorrectly referenced Salesforce app credentials

### 3. Login Verification Interruptions
- Salesforce security mechanisms temporarily blocked repeated OAuth attempts from VPS IP
- Identified as expected platform security behavior during rapid testing

---

## 📌 Current Status

- OAuth application configured and operational in principle
- Authorization Code Flow implemented
- Token exchange script built and tested structurally
- Final authentication stabilization still in progress due to Salesforce security throttling

---

## 🚀 Next Steps (Day 2)

- Stabilize OAuth authentication flow
- Successfully retrieve access and refresh tokens
- Validate API connection with Salesforce
- First test action: create a Lead via Python API call
- Begin structuring AI command layer for CRM automation

---

## 🧠 Notes

Day 1 focused entirely on infrastructure and authentication setup.  
This phase establishes the foundation required for all future AI-driven CRM automation.

---
