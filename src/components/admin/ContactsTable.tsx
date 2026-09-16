"use client";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import ContactRow from "./ContactRow";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { deleteContactById } from "@/actions/contact.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { AlertDialog } from "@/models/alertDialog.model";
import type { Contact } from "@/models/contact.model";
import { useI18n } from "@/i18n";

type ContactsTableProps = {
  contacts: Contact[];
  reloadContacts: () => void;
  editContact: (id: string) => void;
  hideCompanyColumn?: boolean;
};

function ContactsTable({
  contacts,
  reloadContacts,
  editContact,
  hideCompanyColumn,
}: ContactsTableProps) {
  const { t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });

  // A link is meaningless without the person and JobContact cascades from
  // contactId, so the dialog warns about the links rather than blocking.
  const onDeleteContact = (contact: Contact) => {
    const jobs = contact._count?.jobLinks ?? 0;
    setAlert({
      openState: true,
      deleteAction: true,
      itemId: contact.id,
      title: jobs > 0 ? t("contacts.deleteThisContact") : undefined,
      description:
        jobs > 0
          ? t(
              jobs === 1
                ? "contacts.linkedToJobsOne"
                : "contacts.linkedToJobsMany",
              { name: contact.name, count: jobs },
            )
          : undefined,
    });
  };

  const deleteContact = async (contactId: string | undefined) => {
    if (contactId) {
      const { success, message } = await deleteContactById(contactId);
      if (success) {
        toastSuccess(t("contacts.deletedSuccess"));
        reloadContacts();
      } else {
        toastError(message);
      }
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <span className="sr-only">{t("common.expand")}</span>
            </TableHead>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("common.title")}
            </TableHead>
            {!hideCompanyColumn && <TableHead>{t("common.company")}</TableHead>}
            <TableHead>{t("library.roles")}</TableHead>
            <TableHead>{t("common.jobs")}</TableHead>
            <TableHead>{t("contacts.lastContactedLabel")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {contacts.map((contact: Contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              expanded={expandedId === contact.id}
              onToggle={() =>
                setExpandedId((prev) =>
                  prev === contact.id ? null : contact.id,
                )
              }
              onEdit={() => editContact(contact.id)}
              onDelete={() => onDeleteContact(contact)}
              hideCompanyColumn={hideCompanyColumn}
            />
          ))}
        </TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle="contact"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteContact(alert.itemId)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default ContactsTable;
