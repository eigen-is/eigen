import React, { useContext, useCallback } from "react";
import { Button } from "@workspace/ui/components/button";
import { ModalContext } from "../context/modal";

export function useDialog() {
  const { showModal, hideModal } = useContext(ModalContext);

  const showDialog = useCallback(
    (
      content: string | React.ReactNode,
      type?: "ok" | "yesno",
      onOk: () => void = hideModal,
      onCancel: () => void = hideModal
    ) => {
      if (type) {
        showModal(
          <DialogWrapper type={type} onOk={onOk} onCancel={onCancel}>
            {content}
          </DialogWrapper>
        );
      } else {
        showModal(content);
      }
    },
    [hideModal, showModal]
  );

  return { showDialog, hideDialog: hideModal };
}

function DialogWrapper({
  type,
  onOk,
  onCancel,
  children,
}: {
  type: "ok" | "yesno";
  onOk?: () => void;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="p-6 min-w-[280px]">
      <div className="flex items-center justify-center py-4 text-sm">
        {children}
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        {type === "yesno" && (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={onOk}>
          OK
        </Button>
      </div>
    </div>
  );
}
