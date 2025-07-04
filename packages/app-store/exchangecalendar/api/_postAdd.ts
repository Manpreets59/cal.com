import { SoapFaultDetails } from "ews-javascript-api";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { symmetricEncrypt } from "@calcom/lib/crypto";
import { emailSchema } from "@calcom/lib/emailSchema";
import logger from "@calcom/lib/logger";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import prisma from "@calcom/prisma";

import checkSession from "../../_utils/auth";
import { ExchangeAuthentication, ExchangeVersion } from "../enums";
import { CalendarService } from "../lib";
import { ExchangeConfigValidator } from "../lib/validation";

const formSchema = z
  .object({
    url: z.string().url(),
    username: emailSchema,
    password: z.string().min(1, "Password is required"),
    authenticationMethod: z.number().min(0).max(1).default(ExchangeAuthentication.STANDARD),
    exchangeVersion: z.number().min(0).max(8).default(ExchangeVersion.Exchange2016),
    useCompression: z.boolean().default(false),
  })
  .strict()
  .refine(
    (data) => {
      // Validate URL is a proper EWS endpoint
      return data.url.includes("/ews/") || data.url.includes("/EWS/") || data.url.includes("Exchange.asmx");
    },
    {
      message: "URL must be a valid Exchange Web Services (EWS) endpoint",
      path: ["url"],
    }
  );

export async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const session = checkSession(req);
  const body = formSchema.parse(req.body);

  // Additional validation using our custom validator
  const validation = ExchangeConfigValidator.validate(body);
  if (!validation.isValid) {
    return res.status(400).json({
      message: "Invalid Exchange configuration",
      errors: validation.errors,
      suggestions: ExchangeConfigValidator.getSuggestions(body),
    });
  }

  const encrypted = symmetricEncrypt(JSON.stringify(body), process.env.CALENDSO_ENCRYPTION_KEY || "");
  const data = {
    type: "exchange_calendar",
    key: encrypted,
    userId: session.user?.id,
    teamId: null,
    appId: "exchange",
    invalid: false,
    delegationCredentialId: null,
  };

  try {
    const service = new CalendarService({ id: 0, user: { email: session.user.email || "" }, ...data });

    // Test the connection by trying to list calendars with timeout
    const testConnection = Promise.race([
      service?.listCalendars(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection test timeout after 30 seconds")), 30000)
      ),
    ]);

    await testConnection;

    // If successful, create the credential
    await prisma.credential.create({ data });

    logger.info(`Exchange calendar successfully added for user ${session.user?.id}`);
  } catch (reason) {
    logger.error("Failed to add Exchange calendar:", reason);

    // Provide more specific error messages based on the error type
    if (reason instanceof Error) {
      // Handle OpenSSL/Node.js compatibility issues
      if (reason.message.indexOf("digital envelope routines::unsupported") >= 0) {
        return res.status(500).json({
          message:
            "Node.js OpenSSL compatibility issue with NTLM authentication. Please contact your administrator or try using Basic authentication instead.",
        });
      }

      // Handle authentication failures
      if (
        reason.message.indexOf("401") >= 0 ||
        reason.message.indexOf("Unauthorized") >= 0 ||
        reason.message.indexOf("Authentication failed") >= 0
      ) {
        return res.status(401).json({
          message:
            "Authentication failed. Please verify your username and password are correct and that your account has the necessary Exchange permissions.",
        });
      }

      // Handle connection issues
      if (
        reason.message.indexOf("timeout") >= 0 ||
        reason.message.indexOf("ECONNREFUSED") >= 0 ||
        reason.message.indexOf("ENOTFOUND") >= 0
      ) {
        return res.status(500).json({
          message:
            "Cannot connect to Exchange server. Please verify the EWS URL is correct and the server is accessible from this network.",
        });
      }

      // Handle SSL/TLS issues
      if (
        reason.message.indexOf("certificate") >= 0 ||
        reason.message.indexOf("SSL") >= 0 ||
        reason.message.indexOf("TLS") >= 0
      ) {
        return res.status(500).json({
          message:
            "SSL/TLS certificate issue. Your Exchange server may be using a self-signed certificate or there may be a certificate configuration problem.",
        });
      }
    }

    // Handle SOAP faults from Exchange Web Services
    if (reason instanceof SoapFaultDetails && reason.message != "") {
      return res.status(500).json({ message: `Exchange server error: ${reason.message}` });
    }

    // Generic error fallback
    return res.status(500).json({
      message: "Could not add this Exchange account. Please check your configuration and try again.",
    });
  }

  return res.status(200).json({ url: "/apps/installed" });
}

export default defaultResponder(getHandler);
