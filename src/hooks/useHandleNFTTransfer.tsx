import {
  ChainId,
  CHAIN_ID_KLAYTN,
  CHAIN_ID_SOLANA,
  getEmitterAddressEth,
  getEmitterAddressSolana,
  getSignedVAAWithRetry,
  hexToUint8Array,
  isEVMChain,
  parseSequenceFromLogEth,
  parseSequenceFromLogSolana,
  uint8ArrayToHex,
  CHAIN_ID_APTOS,
} from "@certusone/wormhole-sdk";
import {
  transferFromEth,
  transferFromSolana,
  transferFromAptos,
} from "@certusone/wormhole-sdk/lib/esm/nft_bridge";
import { Alert } from "@material-ui/lab";
import { Connection } from "@solana/web3.js";
import { SolanaWallet } from "@xlabs-libs/wallet-aggregator-solana";
import { BigNumber, Signer } from "ethers";
import { arrayify, zeroPad } from "ethers/lib/utils";
import { useSnackbar } from "notistack";
import { useCallback, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useEthereumProvider } from "../contexts/EthereumProviderContext";
import { useSolanaWallet } from "../contexts/SolanaWalletContext";
import {
  setIsSending,
  setSignedVAAHex,
  setTransferTx,
} from "../store/nftSlice";
import {
  selectNFTIsSendComplete,
  selectNFTIsSending,
  selectNFTIsTargetComplete,
  selectNFTOriginAsset,
  selectNFTOriginChain,
  selectNFTOriginTokenId,
  selectNFTSourceAsset,
  selectNFTSourceChain,
  selectNFTSourceParsedTokenAccount,
  selectNFTTargetChain,
} from "../store/selectors";
import {
  getBridgeAddressForChain,
  getNFTBridgeAddressForChain,
  SOLANA_HOST,
  SOL_BRIDGE_ADDRESS,
  SOL_NFT_BRIDGE_ADDRESS,
  WORMHOLE_RPC_HOSTS,
} from "../utils/consts";
import parseError from "../utils/parseError";
import { signSendAndConfirm } from "../utils/solana";
import useNFTTargetAddressHex from "./useNFTTargetAddress";
import { TokenTypes, Types } from "aptos";
import {
  getAptosClient,
  getEmitterAddressAndSequenceFromResult,
  waitForSignAndSubmitTransaction,
} from "../utils/aptos";
import { useAptosContext } from "../contexts/AptosWalletContext";
import { AptosWallet } from "@xlabs-libs/wallet-aggregator-aptos";

async function evm(
  dispatch: any,
  enqueueSnackbar: any,
  signer: Signer,
  tokenAddress: string,
  tokenId: string,
  recipientChain: ChainId,
  recipientAddress: Uint8Array,
  chainId: ChainId
) {
  dispatch(setIsSending(true));
  try {
    // Klaytn requires specifying gasPrice
    const overrides =
      chainId === CHAIN_ID_KLAYTN
        ? { gasPrice: (await signer.getGasPrice()).toString() }
        : {};
    const receipt = await transferFromEth(
      getNFTBridgeAddressForChain(chainId),
      signer,
      tokenAddress,
      tokenId,
      recipientChain,
      recipientAddress,
      overrides
    );
    dispatch(
      setTransferTx({ id: receipt.transactionHash, block: receipt.blockNumber })
    );
    enqueueSnackbar(null, {
      content: <Alert severity="success">Transaction confirmed</Alert>,
    });
    const sequence = parseSequenceFromLogEth(
      receipt,
      getBridgeAddressForChain(chainId)
    );
    const emitterAddress = getEmitterAddressEth(
      getNFTBridgeAddressForChain(chainId)
    );
    enqueueSnackbar(null, {
      content: <Alert severity="info">Fetching VAA</Alert>,
    });
    const { vaaBytes } = await getSignedVAAWithRetry(
      WORMHOLE_RPC_HOSTS,
      chainId,
      emitterAddress,
      sequence.toString()
    );
    dispatch(setSignedVAAHex(uint8ArrayToHex(vaaBytes)));
    enqueueSnackbar(null, {
      content: <Alert severity="success">Fetched Signed VAA</Alert>,
    });
  } catch (e) {
    console.error(e);
    enqueueSnackbar(null, {
      content: <Alert severity="error">{parseError(e)}</Alert>,
    });
    dispatch(setIsSending(false));
  }
}

async function solana(
  dispatch: any,
  enqueueSnackbar: any,
  wallet: SolanaWallet,
  payerAddress: string, //TODO: we may not need this since we have wallet
  fromAddress: string,
  mintAddress: string,
  targetChain: ChainId,
  targetAddress: Uint8Array,
  originAddressStr?: string,
  originChain?: ChainId,
  originTokenId?: string
) {
  dispatch(setIsSending(true));
  try {
    const connection = new Connection(SOLANA_HOST, "confirmed");
    const originAddress = originAddressStr
      ? zeroPad(hexToUint8Array(originAddressStr), 32)
      : undefined;
    const transaction = await transferFromSolana(
      connection,
      SOL_BRIDGE_ADDRESS,
      SOL_NFT_BRIDGE_ADDRESS,
      payerAddress,
      fromAddress,
      mintAddress,
      targetAddress,
      targetChain,
      originAddress,
      originChain,
      arrayify(BigNumber.from(originTokenId || "0"))
    );
    const txid = await signSendAndConfirm(wallet, transaction);
    enqueueSnackbar(null, {
      content: <Alert severity="success">Transaction confirmed</Alert>,
    });
    const info = await connection.getTransaction(txid);
    if (!info) {
      throw new Error("An error occurred while fetching the transaction info");
    }
    dispatch(setTransferTx({ id: txid, block: info.slot }));
    const sequence = parseSequenceFromLogSolana(info);
    const emitterAddress = await getEmitterAddressSolana(
      SOL_NFT_BRIDGE_ADDRESS
    );
    enqueueSnackbar(null, {
      content: <Alert severity="info">Fetching VAA</Alert>,
    });
    const { vaaBytes } = await getSignedVAAWithRetry(
      WORMHOLE_RPC_HOSTS,
      CHAIN_ID_SOLANA,
      emitterAddress,
      sequence
    );

    dispatch(setSignedVAAHex(uint8ArrayToHex(vaaBytes)));
    enqueueSnackbar(null, {
      content: <Alert severity="success">Fetched Signed VAA</Alert>,
    });
  } catch (e) {
    console.error(e);
    enqueueSnackbar(null, {
      content: <Alert severity="error">{parseError(e)}</Alert>,
    });
    dispatch(setIsSending(false));
  }
}

async function aptos(
  dispatch: any,
  enqueueSnackbar: any,
  aptosTokenId: TokenTypes.TokenId,
  targetChain: ChainId,
  targetAddress: Uint8Array,
  aptosWallet: AptosWallet
) {
  dispatch(setIsSending(true));
  const nftBridgeAddress = getNFTBridgeAddressForChain(CHAIN_ID_APTOS);
  try {
    const { creator, collection, name } = aptosTokenId.token_data_id;
    const transferPayload = transferFromAptos(
      nftBridgeAddress,
      creator,
      collection,
      name,
      Number(aptosTokenId.property_version),
      targetChain,
      targetAddress
    );
    const hash = await waitForSignAndSubmitTransaction(
      transferPayload,
      aptosWallet
    );
    dispatch(setTransferTx({ id: hash, block: 1 }));
    enqueueSnackbar(null, {
      content: <Alert severity="success">Transaction confirmed</Alert>,
    });
    const result = (await getAptosClient().waitForTransactionWithResult(
      hash
    )) as Types.UserTransaction;
    const { emitterAddress, sequence } =
      getEmitterAddressAndSequenceFromResult(result);
    enqueueSnackbar(null, {
      content: <Alert severity="info">Fetching VAA</Alert>,
    });
    const { vaaBytes } = await getSignedVAAWithRetry(
      WORMHOLE_RPC_HOSTS,
      CHAIN_ID_APTOS,
      emitterAddress,
      sequence
    );
    dispatch(setSignedVAAHex(uint8ArrayToHex(vaaBytes)));
    enqueueSnackbar(null, {
      content: <Alert severity="success">Fetched Signed VAA</Alert>,
    });
  } catch (e) {
    console.error(e);
    enqueueSnackbar(null, {
      content: <Alert severity="error">{parseError(e)}</Alert>,
    });
    dispatch(setIsSending(false));
  }
}

export function useHandleNFTTransfer() {
  const dispatch = useDispatch();
  const { enqueueSnackbar } = useSnackbar();
  const sourceChain = useSelector(selectNFTSourceChain);
  const sourceAsset = useSelector(selectNFTSourceAsset);
  const nftSourceParsedTokenAccount = useSelector(
    selectNFTSourceParsedTokenAccount
  );
  const sourceTokenId = nftSourceParsedTokenAccount?.tokenId || ""; // this should exist by this step for NFT transfers
  const aptosTokenId = nftSourceParsedTokenAccount?.aptosTokenId;
  const originChain = useSelector(selectNFTOriginChain);
  const originAsset = useSelector(selectNFTOriginAsset);
  const originTokenId = useSelector(selectNFTOriginTokenId);
  const targetChain = useSelector(selectNFTTargetChain);
  const targetAddress = useNFTTargetAddressHex();
  const isTargetComplete = useSelector(selectNFTIsTargetComplete);
  const isSending = useSelector(selectNFTIsSending);
  const isSendComplete = useSelector(selectNFTIsSendComplete);
  const { signer } = useEthereumProvider(sourceChain as any);
  const { publicKey: solPK, wallet: solanaWallet } = useSolanaWallet();
  const { account: aptosAccount, wallet: aptosWallet } = useAptosContext();
  const sourceParsedTokenAccount = useSelector(
    selectNFTSourceParsedTokenAccount
  );
  const sourceTokenPublicKey = sourceParsedTokenAccount?.publicKey;
  const disabled = !isTargetComplete || isSending || isSendComplete;
  const handleTransferClick = useCallback(() => {
    // TODO: we should separate state for transaction vs fetching vaa
    if (
      isEVMChain(sourceChain) &&
      !!signer &&
      !!sourceAsset &&
      !!sourceTokenId &&
      !!targetAddress
    ) {
      evm(
        dispatch,
        enqueueSnackbar,
        signer,
        sourceAsset,
        sourceTokenId,
        targetChain,
        targetAddress,
        sourceChain
      );
    } else if (
      sourceChain === CHAIN_ID_SOLANA &&
      !!solanaWallet &&
      !!solPK &&
      !!sourceAsset &&
      !!sourceTokenPublicKey &&
      !!targetAddress
    ) {
      solana(
        dispatch,
        enqueueSnackbar,
        solanaWallet,
        solPK,
        sourceTokenPublicKey,
        sourceAsset,
        targetChain,
        targetAddress,
        originAsset,
        originChain,
        originTokenId
      );
    } else if (
      sourceChain === CHAIN_ID_APTOS &&
      !!aptosAccount &&
      !!aptosWallet &&
      !!targetAddress &&
      !!aptosTokenId
    ) {
      aptos(
        dispatch,
        enqueueSnackbar,
        aptosTokenId,
        targetChain,
        targetAddress,
        aptosWallet
      );
    }
  }, [
    dispatch,
    enqueueSnackbar,
    sourceChain,
    signer,
    solanaWallet,
    solPK,
    sourceTokenPublicKey,
    sourceAsset,
    sourceTokenId,
    targetChain,
    targetAddress,
    originAsset,
    originChain,
    originTokenId,
    aptosAccount,
    aptosWallet,
    aptosTokenId,
  ]);
  return useMemo(
    () => ({
      handleClick: handleTransferClick,
      disabled,
      showLoader: isSending,
    }),
    [handleTransferClick, disabled, isSending]
  );
}
