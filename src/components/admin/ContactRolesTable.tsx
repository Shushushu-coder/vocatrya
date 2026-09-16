"use client";
import { useState } from "react";
import { Button } from "../ui/button";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { ContactRole } from "@/models/contact.model";
import { MoreVertical, Trash } from "lucide-react";
import { AlertDialog } from "@/models/alertDialog.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { deleteContactRoleById } from "@/actions/contactRole.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

type ContactRolesTableProps = {
  roles: ContactRole[];
  reloadRoles: () => void;
};

function ContactRolesTable({ roles, reloadRoles }: ContactRolesTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });

  const onDeleteRole = (role: ContactRole) => {
    const links = role._count?.jobContacts ?? 0;
    const holders = role._count?.contacts ?? 0;
    if (links > 0 || holders > 0) {
      setAlert({
        openState: true,
        title: t("library.associatedContactsExist"),
        description: links
          ? t(
              links === 1
                ? "library.roleUsedByLinksOne"
                : "library.roleUsedByLinksMany",
              { count: links },
            )
          : t(
              holders === 1
                ? "library.roleUsedByContactsOne"
                : "library.roleUsedByContactsMany",
              { count: holders },
            ),
        deleteAction: false,
      });
    } else {
      setAlert({ openState: true, deleteAction: true, itemId: role.id });
    }
  };

  const deleteRole = async (roleId: string) => {
    if (roleId) {
      const { success, message } = await deleteContactRoleById(roleId);
      if (success) {
        toastSuccess(t("library.contactRoleDeleted"));
        reloadRoles();
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
            <TableHead>{t("common.role")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("library.value")}
            </TableHead>
            <TableHead>{t("library.contactsLinked")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((role: ContactRole) => {
            return (
              <TableRow key={role.id}>
                <TableCell className="font-medium">{role.label}</TableCell>
                <TableCell className="font-medium hidden sm:table-cell">
                  {role.value}
                </TableCell>
                <TableCell className="font-medium">
                  {role._count?.jobContacts ?? 0}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-haspopup="true" size="icon" variant="ghost">
                        <MoreVertical className="h-4 w-4" />
                        <span className="sr-only">{t("common.toggleMenu")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                      <DropdownMenuItem
                        className="text-red-600 cursor-pointer"
                        onClick={() => onDeleteRole(role)}
                      >
                        <Trash className="mr-2 h-4 w-4" />
                        {t("common.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle="role"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteRole(alert.itemId!)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default ContactRolesTable;
