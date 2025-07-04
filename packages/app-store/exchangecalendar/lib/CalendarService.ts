import type { FindFoldersResults, FindItemsResults } from "ews-javascript-api";
import {
  Appointment,
  Attendee,
  BasePropertySet,
  CalendarView,
  ConflictResolutionMode,
  DateTime,
  DeleteMode,
  ExchangeService,
  Folder,
  FolderId,
  FolderSchema,
  FolderTraversal,
  FolderView,
  ItemId,
  LegacyFreeBusyStatus,
  LogicalOperator,
  MessageBody,
  PropertySet,
  SearchFilter,
  SendInvitationsMode,
  SendInvitationsOrCancellationsMode,
  Uri,
  WebCredentials,
  WellKnownFolderName,
} from "ews-javascript-api";

import { symmetricDecrypt } from "@calcom/lib/crypto";
import logger from "@calcom/lib/logger";
import type {
  Calendar,
  CalendarEvent,
  EventBusyDate,
  IntegrationCalendar,
  NewCalendarEventType,
  Person,
} from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";

import { ExchangeAuthentication } from "../enums";

export default class ExchangeCalendarService implements Calendar {
  private integrationName = "";
  private log: typeof logger;
  private payload;

  constructor(credential: CredentialPayload) {
    this.integrationName = "exchange_calendar";
    this.log = logger.getSubLogger({ prefix: [`[[lib] ${this.integrationName}`] });
    this.payload = JSON.parse(
      symmetricDecrypt(credential.key?.toString() || "", process.env.CALENDSO_ENCRYPTION_KEY || "")
    );
  }

  async createEvent(event: CalendarEvent): Promise<NewCalendarEventType> {
    const appointment: Appointment = new Appointment(await this.getExchangeService());
    appointment.Subject = event.title;
    appointment.Start = DateTime.Parse(event.startTime);
    appointment.End = DateTime.Parse(event.endTime);
    appointment.Location = event.location || "";
    appointment.Body = new MessageBody(event.description || "");
    event.attendees.forEach((attendee: Person) => {
      appointment.RequiredAttendees.Add(new Attendee(attendee.email));
    });
    if (event.team?.members) {
      event.team.members.forEach((member: Person) => {
        appointment.RequiredAttendees.Add(new Attendee(member.email));
      });
    }
    return appointment
      .Save(SendInvitationsMode.SendToAllAndSaveCopy)
      .then(() => {
        return {
          uid: appointment.Id.UniqueId,
          id: appointment.Id.UniqueId,
          password: "",
          type: "",
          url: "",
          additionalInfo: {},
        };
      })
      .catch((reason) => {
        this.log.error("Error creating Exchange event:", reason);
        throw reason;
      });
  }

  async updateEvent(
    uid: string,
    event: CalendarEvent
  ): Promise<NewCalendarEventType | NewCalendarEventType[]> {
    const appointment: Appointment = await Appointment.Bind(await this.getExchangeService(), new ItemId(uid));
    appointment.Subject = event.title;
    appointment.Start = DateTime.Parse(event.startTime);
    appointment.End = DateTime.Parse(event.endTime);
    appointment.Location = event.location || "";
    appointment.Body = new MessageBody(event.description || "");
    event.attendees.forEach((attendee: Person) => {
      appointment.RequiredAttendees.Add(new Attendee(attendee.email));
    });
    if (event.team?.members) {
      event.team.members.forEach((member) => {
        appointment.RequiredAttendees.Add(new Attendee(member.email));
      });
    }
    return appointment
      .Update(
        ConflictResolutionMode.AlwaysOverwrite,
        SendInvitationsOrCancellationsMode.SendToChangedAndSaveCopy
      )
      .then(() => {
        return {
          uid: appointment.Id.UniqueId,
          id: appointment.Id.UniqueId,
          password: "",
          type: "",
          url: "",
          additionalInfo: {},
        };
      })
      .catch((reason) => {
        this.log.error("Error updating Exchange event:", reason);
        throw reason;
      });
  }

  async deleteEvent(uid: string): Promise<void> {
    const appointment: Appointment = await Appointment.Bind(await this.getExchangeService(), new ItemId(uid));
    return appointment.Delete(DeleteMode.MoveToDeletedItems).catch((reason) => {
      this.log.error("Error deleting Exchange event:", reason);
      throw reason;
    });
  }

  async getAvailability(
    dateFrom: string,
    dateTo: string,
    selectedCalendars: IntegrationCalendar[]
  ): Promise<EventBusyDate[]> {
    const calendars: IntegrationCalendar[] = await this.listCalendars();
    const promises: Promise<EventBusyDate[]>[] = calendars
      .filter((lcal) => selectedCalendars.some((rcal) => lcal.externalId == rcal.externalId))
      .map(async (calendar) => {
        return (await this.getExchangeService())
          .FindAppointments(
            new FolderId(calendar.externalId),
            new CalendarView(DateTime.Parse(dateFrom), DateTime.Parse(dateTo))
          )
          .then((results: FindItemsResults<Appointment>) => {
            return results.Items.filter((appointment: Appointment) => {
              return appointment.LegacyFreeBusyStatus != LegacyFreeBusyStatus.Free;
            }).map((appointment: Appointment) => {
              return {
                start: new Date(appointment.Start.ToISOString()),
                end: new Date(appointment.End.ToISOString()),
              };
            });
          })
          .catch((reason) => {
            this.log.error("Error getting availability from Exchange calendar:", reason);
            throw reason;
          });
      });
    return Promise.all(promises).then((x) => x.flat());
  }

  async listCalendars(): Promise<IntegrationCalendar[]> {
    const service: ExchangeService = await this.getExchangeService();
    const view: FolderView = new FolderView(1000);
    view.PropertySet = new PropertySet(BasePropertySet.IdOnly);
    view.PropertySet.Add(FolderSchema.ParentFolderId);
    view.PropertySet.Add(FolderSchema.DisplayName);
    view.PropertySet.Add(FolderSchema.ChildFolderCount);
    view.Traversal = FolderTraversal.Deep;
    const deletedItemsFolder: Folder = await Folder.Bind(service, WellKnownFolderName.DeletedItems);
    const searchFilterCollection = new SearchFilter.SearchFilterCollection(LogicalOperator.And);
    searchFilterCollection.Add(new SearchFilter.IsEqualTo(FolderSchema.FolderClass, "IPF.Appointment"));
    return service
      .FindFolders(WellKnownFolderName.MsgFolderRoot, searchFilterCollection, view)
      .then((res: FindFoldersResults) => {
        return res.Folders.filter((folder: Folder) => {
          return folder.ParentFolderId.UniqueId != deletedItemsFolder.Id.UniqueId;
        }).map((folder: Folder) => {
          return {
            externalId: folder.Id.UniqueId,
            name: folder.DisplayName ?? "",
            primary: folder.ChildFolderCount > 0,
            integration: this.integrationName,
          };
        });
      })
      .catch((reason) => {
        this.log.error("Error listing Exchange calendars:", reason);
        throw reason;
      });
  }

  private async getExchangeService(): Promise<ExchangeService> {
    try {
      const service: ExchangeService = new ExchangeService(this.payload.exchangeVersion);
      service.Credentials = new WebCredentials(this.payload.username, this.payload.password);
      service.Url = new Uri(this.payload.url);
      
      if (this.payload.authenticationMethod === ExchangeAuthentication.NTLM) {
        // Fix for Node.js OpenSSL compatibility issues with NTLM
        try {
          // Set Node.js to use legacy OpenSSL provider if needed
          if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes('--openssl-legacy-provider')) {
            process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --openssl-legacy-provider`;
          } else if (!process.env.NODE_OPTIONS) {
            process.env.NODE_OPTIONS = '--openssl-legacy-provider';
          }

          const { XhrApi } = await import("@ewsjs/xhr");
          const xhr = new XhrApi({
            rejectUnauthorized: false,
            // Additional options for better on-premise Exchange compatibility
            timeout: 30000, // 30 second timeout
          }).useNtlmAuthentication(this.payload.username, this.payload.password);
          
          service.XHRApi = xhr;
          this.log.info("NTLM authentication configured for Exchange service");
        } catch (ntlmError) {
          this.log.error("Error configuring NTLM authentication:", ntlmError);
          // Fallback to standard authentication if NTLM fails
          this.log.info("Falling back to standard authentication");
        }
      } else {
        // Enhanced Basic Authentication setup for on-premise Exchange
        service.Credentials = new WebCredentials(this.payload.username, this.payload.password);
        this.log.info("Basic authentication configured for Exchange service");
      }

      return service;
    } catch (error) {
      this.log.error("Error creating Exchange service:", error);
      
      // Provide more specific error messages based on the error type
      if (error instanceof Error) {
        if (error.message.includes('digital envelope routines::unsupported')) {
          throw new Error(
            'Node.js OpenSSL compatibility issue. Please set NODE_OPTIONS="--openssl-legacy-provider" or upgrade your Exchange server configuration.'
          );
        } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
          throw new Error(
            'Authentication failed. Please verify your username, password, and ensure the account has proper Exchange permissions.'
          );
        } else if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
          throw new Error(
            'Cannot connect to Exchange server. Please verify the EWS URL and ensure the server is accessible.'
          );
        }
      }
      
      throw error;
    }
  }
}
